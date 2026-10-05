"""Estadísticas por jugador de los Clippers de Samba a partir de las actas oficiales.

Lee los partidos de la API pública de Leverade, descarga el acta (PDF) de cada partido
terminado y saca de ella la ficha del partido: para cada dorsal, puntos (también por periodo),
tiros anotados (1, 2 y 3), faltas por tipo y si salió de titular; y del equipo, los parciales,
los tiros libres y los tiempos muertos. Suma la temporada con los partidos cuyo acta cuadra.
Escribe public/datos/estadisticas.json. Se lanza antes de desplegar, como calendario.mjs.
  python scripts/estadisticas.py
Necesita PyMuPDF: pip install -r requirements.txt
"""

from __future__ import annotations

import http.client
import json
import os
import hashlib
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter
from dataclasses import dataclass
from datetime import datetime, timezone
from functools import cache, reduce
from itertools import accumulate, zip_longest
from pathlib import Path
from typing import Any, NamedTuple
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

try:
    import pymupdf as fitz  # PyMuPDF >= 1.24.3
except ImportError:
    try:
        import fitz  # PyMuPDF antiguo
    except ImportError:
        sys.exit("Falta PyMuPDF: pip install -r requirements.txt")

# --- Liga y equipos -----------------------------------------------------------
API = "https://api.leverade.com"
TORNEO_ID = "1342549"  # LIGA QUIRONSALUD ALQUERIA MASCULINA 26/27 (los grupos son de este torneo)
EQUIPOS: dict[str, dict[str, str]] = {
    "A": {"team_id": "15925482", "group_id": "3714586", "grupo": "DIVISION TERCERA"},
    "B": {"team_id": "15925118", "group_id": "3714583", "grupo": "DIVISION QUINTA"},
}

# --- Rutas y salida -------------------------------------------------------------
RAIZ = Path(__file__).resolve().parent.parent
DESTINO = RAIZ / "public" / "datos" / "estadisticas.json"
EQUIPOS_JSON = RAIZ / "public" / "datos" / "equipos.json"
CACHE_ACTAS = RAIZ / ".cache" / "actas"
FUENTE = "Actas oficiales de la liga (Leverade)"
ZONA = "Europe/Madrid"

# --- Red (la API admite ~400 peticiones/min; vamos de una en una y sin prisa) ----
USER_AGENT = "Mozilla/5.0 (compatible; clippers-de-samba-web)"
CABECERAS_API = {"Accept": "application/vnd.api+json", "User-Agent": USER_AGENT}
TIMEOUT_S = 30
INTENTOS = 3
PAUSA_REINTENTO_S = 2.0
PAUSA_DESCARGA_S = 1.0
MAX_PAGINAS = 20

# --- Plantilla del acta (formato FIBA de NBN23/Leverade, coordenadas en puntos) ----
A_SCORE_X = [290, 366, 443, 518]  # columna del tanteo arrastrado del equipo A en cada bloque
B_SCORE_X = [310, 385, 462, 537]  # y del equipo B
FOUL_RE = re.compile(r"^(P|U|T|D|C|B|F|GD)([0-9C]*)$")  # tipo + tiros libres concedidos ("P2"); "C" = anulados
FINAL_RE = re.compile(r"Resultado Final.*?A\s*(\d+).*?B\s*(\d+)", re.S)
ROJO, AZUL = 0xFF0000, 0x0000FF  # tinta de los periodos 1 y 3 (rojo) y 2 y 4 (azul)
TIEMPOS_FILA0 = 10.4  # las casillas de «Tiempos» empiezan 10,4 pt bajo el título...
TIEMPOS_ALTO = 12.7  # ...en filas de este alto: 1.ª parte, 2.ª parte y prórrogas
TIEMPOS_CASILLAS = (2, 3, 3)  # casillas de cada fila
TITULARES = 5
CAMPOS_SUMABLES = ("puntos", "t1", "t2", "t3", "faltas")

Palabra = tuple[float, float, float, float, str, int, int, int]
Trazo = tuple[float, float, float, float, str, int]  # fragmento de texto con su color (x0, y0, x1, y1, texto, color)
Caja = tuple[float, float, float, float]


class Canasta(NamedTuple):
    dorsal: int
    puntos: int
    marcador: int  # tanteo acumulado del equipo tras la canasta
    color: int | None  # tinta del dorsal en el tanteo arrastrado (dice la paridad del periodo)


class ErrorRed(Exception):
    """Una petición HTTP no ha podido completarse tras los reintentos."""


class ActaIlegible(Exception):
    """El PDF no tiene la estructura de acta esperada."""


@dataclass(frozen=True)
class ResultadoEquipo:
    partidos: list[dict[str, Any]]
    jugadores: list[dict[str, Any]]
    analizados: int
    descartados: int
    actas_leidas: int
    fallos_descarga: int


@dataclass(frozen=True)
class Analisis:
    """Lo que da de sí el acta de un partido, visto desde el lado de Clippers."""
    stats: dict[int, dict[str, Any]]  # ficha de cada dorsal en el partido
    detalle: dict[str, Any]  # cuartos, tl, tlRival y tiemposMuertos (los que se han podido leer)
    problemas: list[str]  # motivos por los que el acta no cuadra (vacía si cuadra)
    avisos: list[str]  # campos que no se han podido leer y se omiten


# --- Red ------------------------------------------------------------------------
def descargar(url: str, cabeceras: dict[str, str]) -> bytes:
    ultimo: Exception | None = None
    for intento in range(1, INTENTOS + 1):
        try:
            peticion = urllib.request.Request(url, headers=cabeceras)
            with urllib.request.urlopen(peticion, timeout=TIMEOUT_S) as respuesta:
                return respuesta.read()
        except urllib.error.HTTPError as e:
            ultimo = e
            if e.code < 500 and e.code != 429:  # un 4xx no se arregla reintentando
                break
        except (OSError, http.client.HTTPException) as e:
            ultimo = e
        if intento < INTENTOS:
            time.sleep(PAUSA_REINTENTO_S * intento)
    raise ErrorRed(f"{url}: {ultimo}")


def api_json(url: str) -> dict[str, Any]:
    try:
        datos = json.loads(descargar(url, CABECERAS_API))
    except ValueError as e:
        raise ErrorRed(f"{url}: la respuesta no es JSON ({e})") from e
    if "errors" in datos:
        raise ErrorRed(f"{url}: {datos['errors']}")
    return datos


def partidos_api(team_id: str, group_id: str) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Partidos del equipo en su grupo, con marcadores y equipos incluidos (todas las páginas)."""
    consulta = urllib.parse.urlencode({
        "filter": f"round.group.id:{group_id},teams.id:{team_id}",
        "include": "results,teams",
        "page[size]": "100",
    })
    url: str | None = f"{API}/matches?{consulta}"
    datos: list[dict[str, Any]] = []
    incluidos: list[dict[str, Any]] = []
    for _ in range(MAX_PAGINAS):
        if not url or not url.startswith(API):
            break
        pagina = api_json(url)
        datos.extend(pagina.get("data", []))
        incluidos.extend(pagina.get("included", []))
        url = (pagina.get("links") or {}).get("next")
    return datos, incluidos


def nombres_equipos(incluidos: list[dict[str, Any]]) -> dict[str, str]:
    return {i["id"]: i["attributes"]["name"] for i in incluidos if i.get("type") == "team"}


def marcadores(incluidos: list[dict[str, Any]]) -> dict[str, dict[str, int]]:
    """{match_id: {team_id: puntos}} con el resultado final de cada partido."""
    out: dict[str, dict[str, int]] = {}
    for i in incluidos:
        if i.get("type") != "result" or (i["relationships"].get("period") or {}).get("data"):
            continue
        match_id = i["relationships"]["match"]["data"]["id"]
        team_id = i["relationships"]["team"]["data"]["id"]
        out.setdefault(match_id, {})[team_id] = i["attributes"]["value"]
    return out


def ruta_acta(match_id: str, url: str) -> Path:
    """Fichero de caché del acta. Lleva una huella de la URL: si la liga sube un acta
    corregida (URL nueva), se descarga otra vez."""
    if not re.fullmatch(r"\d+", match_id):
        raise ErrorRed(f"identificador de partido inesperado: {match_id!r}")
    huella = hashlib.sha256(url.encode("utf-8")).hexdigest()[:12]
    return CACHE_ACTAS / f"{match_id}-{huella}.pdf"


def obtener_acta(match_id: str, url: str) -> tuple[bytes, bool]:
    """PDF del acta desde la caché o, si no está, descargado. Devuelve (pdf, recien_descargado)."""
    if urllib.parse.urlsplit(url).scheme != "https":
        raise ErrorRed(f"URL de acta no segura: {url!r}")
    ruta = ruta_acta(match_id, url)
    if ruta.is_file():
        return ruta.read_bytes(), False
    pdf = descargar(url, {"User-Agent": USER_AGENT})
    if not pdf.startswith(b"%PDF"):
        raise ErrorRed(f"{url}: la respuesta no es un PDF")
    CACHE_ACTAS.mkdir(parents=True, exist_ok=True)
    temporal = ruta.with_suffix(".pdf.part")
    temporal.write_bytes(pdf)
    os.replace(temporal, ruta)
    return pdf, True


# --- Lectura del acta -----------------------------------------------------------------
def near(v: float, target: float, tol: float) -> bool:
    return abs(v - target) <= tol


def centro_dentro(w: Palabra | Trazo, caja: Caja) -> bool:
    cx, cy = (w[0] + w[2]) / 2, (w[1] + w[3]) / 2
    return caja[0] <= cx <= caja[2] and caja[1] <= cy <= caja[3]


def trazos(page: Any) -> list[Trazo]:
    """Fragmentos de texto con su color, que las palabras de get_text("words") no traen."""
    out: list[Trazo] = []
    for bloque in page.get_text("dict")["blocks"]:
        for linea in bloque.get("lines", []):
            for s in linea["spans"]:
                texto = s["text"].strip()
                if texto:
                    out.append((*s["bbox"], texto, s["color"]))
    return out


def circulos_entrada(page: Any) -> list[Caja]:
    """Círculos dibujados en la columna «Entr»: rodean la X de los titulares."""
    out: list[Caja] = []
    for d in page.get_drawings():
        r = d["rect"]
        if (140 < r.x0 < 158 and 6 < r.width < 12 and abs(r.width - r.height) < 2
                and d["items"] and all(item[0] == "c" for item in d["items"])):
            out.append((r.x0, r.y0, r.x1, r.y1))
    return out


def leer_falta(token: str) -> tuple[str, int]:
    """'P2' -> ('P', 2): tipo de falta y tiros libres que concede (el subíndice; con «C», anulados)."""
    m = FOUL_RE.match(token)
    if not m:
        raise ValueError(f"falta ilegible: {token!r}")
    tipo, resto = m.group(1), m.group(2)
    digitos = re.sub(r"\D", "", resto)
    return tipo, 0 if "C" in resto or not digitos else int(digitos)


def faltas_banquillo(words: list[Palabra], y_entrenador: float) -> list[tuple[str, int]]:
    """Faltas del entrenador y del ayudante: sus tiros libres también los lanza el rival."""
    return [leer_falta(w[4]) for w in words
            if y_entrenador - 3 < w[1] < y_entrenador + 25 and 160 <= w[0] < 260 and FOUL_RE.match(w[4])]


def parse_roster(words: list[Palabra], y0: float, y1: float, circulos: list[Caja]) -> list[dict[str, Any]]:
    """Filas de la tabla de jugadores entre y0 e y1 (x < 245)."""
    ws = [w for w in words if y0 < w[1] < y1 and w[0] < 245]
    rows: list[dict[str, Any]] = []
    for w in sorted(ws, key=lambda w: (w[1], w[0])):
        for row in rows:
            if abs(row["y"] - w[1]) <= 3:
                row["w"].append(w)
                break
        else:
            rows.append({"y": w[1], "w": [w]})
    players = []
    for row in rows:
        ws_ = sorted(row["w"], key=lambda w: w[0])
        name_tokens = [w[4] for w in ws_ if 40 <= w[0] < 130]
        num_tokens = [w[4] for w in ws_ if 128 <= w[0] < 145 and w[4].isdigit()]
        if not name_tokens:
            continue
        if not num_tokens:  # el nombre invade la columna del dorsal, p. ej. "RODA11"
            m = re.match(r"^(.*?)(\d+)$", name_tokens[-1])
            if not m:
                continue
            name_tokens[-1] = m.group(1)
            num_tokens = [m.group(2)]
        entrada = [w for w in ws_ if w[4] == "X" and 145 <= w[0] < 158]
        fouls = [leer_falta(w[4]) for w in ws_ if 160 <= w[0] < 245 and FOUL_RE.match(w[4])]
        name = " ".join(t for t in name_tokens if t).replace("(CAP) ", "").strip()
        players.append({
            "dorsal": int(num_tokens[0]), "nombre": name, "jugo": bool(entrada),
            "titular": any(centro_dentro(w, c) for w in entrada for c in circulos), "faltas": fouls,
        })
    return players


def color_de(w: Palabra, spans: list[Trazo]) -> int | None:
    return next((t[5] for t in spans if t[4] == w[4] and near(t[0], w[0], 1) and near(t[1], w[1], 1)), None)


def parse_running_score(words: list[Palabra], spans: list[Trazo]) -> dict[str, dict[str, Any]]:
    """Tanteo arrastrado: total de cada lado y lista de canastas en orden."""
    marks: dict[str, list[tuple[int, int, int | None]]] = {"A": [], "B": []}
    ints = [w for w in words if w[4].isdigit()]
    for blk in range(4):
        ax, bx = A_SCORE_X[blk], B_SCORE_X[blk]
        for w in ints:
            if not near(w[0], ax, 4):
                continue
            y, n = w[1], int(w[4])
            for v in ints:
                if abs(v[1] - y) <= 4 and near(v[0], ax - 18, 8):
                    marks["A"].append((n, int(v[4]), color_de(v, spans)))
                if abs(v[1] - y) <= 4 and near(v[0], bx + 17, 9):
                    marks["B"].append((n, int(v[4]), color_de(v, spans)))
    out = {}
    for side, ms in marks.items():
        prev, canastas = 0, []
        for n, dorsal, color in sorted(set(ms), key=lambda m: (m[0], m[1])):
            canastas.append(Canasta(dorsal, n - prev, n, color))
            prev = n
        out[side] = {"total": prev, "canastas": canastas}
    return out


def parse_periodos(words: list[Palabra]) -> list[tuple[int, int]] | None:
    """Cuadro de parciales («Periodo 1..4» y «Tiempos extra»): [(A, B), ...] en orden, con la
    prórroga al final si la hubo (el acta la da en una sola casilla). None si falta algún parcial."""
    etiquetas = [w for w in words if w[4] == "Periodo" and w[0] > 250]
    if not etiquetas:
        return None
    y = etiquetas[0][1]
    fila = sorted((w for w in words if w[0] > 250 and y + 10 < w[1] < y + 30), key=lambda w: w[0])
    cajas: list[dict[str, int]] = []
    lado: str | None = None
    for w in fila:
        if w[4] in ("A", "B"):
            lado = w[4]
            if lado == "A":
                cajas.append({})
        elif lado and cajas and w[4].isdigit():
            cajas[-1][lado] = int(w[4])
    if len(cajas) < 4 or any(len(c) != 2 for c in cajas[:4]) or any(len(c) == 1 for c in cajas[4:]):
        return None
    return [(c["A"], c["B"]) for c in cajas if len(c) == 2]


def parse_tiempos(spans: list[Trazo], y_titulo: float) -> list[dict[str, Any]] | None:
    """Tiempos muertos de un equipo (minuto y periodo). La fila de la casilla dice la parte
    (1.ª, 2.ª o prórroga) y la tinta, el periodo dentro de ella. None si algo no se entiende."""
    arriba, abajo = y_titulo + TIEMPOS_FILA0, y_titulo + TIEMPOS_FILA0 + len(TIEMPOS_CASILLAS) * TIEMPOS_ALTO
    leidos = []
    for t in spans:
        cy = (t[1] + t[3]) / 2
        if t[0] >= 70 or not arriba < cy < abajo:
            continue
        fila = int((cy - arriba) // TIEMPOS_ALTO)
        if not t[4].isdigit() or (fila < 2 and t[5] not in (ROJO, AZUL)):
            return None
        periodo = "PR" if fila == 2 else str(2 * fila + (1 if t[5] == ROJO else 2))
        leidos.append((fila, t[0], {"periodo": periodo, "minuto": int(t[4])}))
    if any(sum(1 for f, _, _ in leidos if f == fila) > n for fila, n in enumerate(TIEMPOS_CASILLAS)):
        return None
    return [t for _, _, t in sorted(leidos, key=lambda x: (x[0], x[1]))]


def nombres_cabecera(words: list[Palabra]) -> dict[str, str]:
    """Primera línea del acta: "Equipo A <nombre> ... Equipo B <nombre>" -> {"A": ..., "B": ...}."""
    marcas = sorted((w for w in words if w[4] == "Equipo"), key=lambda w: (w[1], w[0]))
    if not marcas:
        return {}
    linea = sorted((w for w in words if abs(w[1] - marcas[0][1]) <= 3), key=lambda w: w[0])
    out: dict[str, list[str]] = {}
    actual: list[str] | None = None
    for i, w in enumerate(linea):
        if w[4] == "Equipo" and i + 1 < len(linea) and linea[i + 1][4] in ("A", "B"):
            actual = out.setdefault(linea[i + 1][4], [])
        elif actual is not None and w[4] not in ("A", "B"):
            actual.append(w[4])
    return {lado: " ".join(tokens) for lado, tokens in out.items()}


def parse_acta(pdf: bytes) -> dict[str, Any]:
    try:
        with fitz.open(stream=pdf, filetype="pdf") as doc:
            page = doc[0]
            words = page.get_text("words")
            text = page.get_text()
            spans = trazos(page)
            circulos = circulos_entrada(page)
    except (RuntimeError, ValueError, IndexError) as e:
        raise ActaIlegible(f"PDF no válido ({e})") from e
    heads = sorted(w[1] for w in words if w[4] == "Jugadores")
    trainers = sorted(w[1] for w in words if w[4] == "Entrenador")
    if len(heads) < 2 or len(trainers) < 2:
        raise ActaIlegible("no se encuentran las dos tablas de jugadores")
    # «Tiempos» a la izquierda es el título del cuadro de cada equipo; «Tiempos extra» va más a la derecha
    tiempos = sorted(w[1] for w in words if w[4] == "Tiempos" and w[0] < 60)
    final = FINAL_RE.search(text)
    try:
        return {
            "A": parse_roster(words, heads[0] + 5, trainers[0] - 2, circulos),
            "B": parse_roster(words, heads[1] + 5, trainers[1] - 2, circulos),
            "banquillo": {"A": faltas_banquillo(words, trainers[0]), "B": faltas_banquillo(words, trainers[1])},
            "score": parse_running_score(words, spans),
            "periodos": parse_periodos(words),
            "tiempos": ({lado: parse_tiempos(spans, y) for lado, y in zip("AB", tiempos)}
                        if len(tiempos) == 2 else {}),
            "final": {"A": int(final.group(1)), "B": int(final.group(2))} if final else None,
            "cabecera": nombres_cabecera(words),
        }
    except (IndexError, ValueError) as e:
        raise ActaIlegible(f"formato inesperado ({e})") from e


def lado_clippers(cabecera: dict[str, str], es_local: bool) -> tuple[str, str | None]:
    """Lado del acta (A = local) de Clippers; si la cabecera del acta dice otra cosa, manda el acta."""
    esperado = "A" if es_local else "B"
    por_nombre = [lado for lado, nombre in cabecera.items() if "CLIPPERS" in nombre.upper()]
    if len(por_nombre) == 1 and por_nombre[0] != esperado:
        rol = "local" if es_local else "visitante"
        nota = f"el acta pone a Clippers como equipo {por_nombre[0]} pero la API lo da como {rol}; se usa el acta"
        return por_nombre[0], nota
    return esperado, None


def periodo_de(marcador: int, cortes: list[int]) -> int | None:
    """Índice del periodo de una canasta: el primero cuyo tanteo acumulado al final no ha superado."""
    return next((k for k, corte in enumerate(cortes) if marcador <= corte), None)


def stats_partido(roster: list[dict[str, Any]], canastas: list[Canasta],
                  cortes: list[int] | None) -> dict[int, dict[str, Any]]:
    """Ficha de cada dorsal en el partido. Con los «cortes» (tanteo acumulado del equipo al final
    de cada periodo) reparte también sus puntos por periodo."""
    out: dict[int, dict[str, Any]] = {}
    for p in roster:
        suyas = [c for c in canastas if c.dorsal == p["dorsal"]]
        tiros = [c.puntos for c in suyas]
        ficha = {
            "nombreActa": p["nombre"], "jugo": p["jugo"], "titular": p["titular"], "puntos": sum(tiros),
            "t1": tiros.count(1), "t2": tiros.count(2), "t3": tiros.count(3), "faltas": len(p["faltas"]),
            "faltasTipo": dict(Counter(tipo for tipo, _ in p["faltas"])),
        }
        if cortes is not None:
            por_cuarto = [0] * len(cortes)
            for c in suyas:
                k = periodo_de(c.marcador, cortes)
                if k is not None:
                    por_cuarto[k] += c.puntos
            ficha["porCuarto"] = por_cuarto
        out[p["dorsal"]] = ficha
    return out


def problemas_cuadre(roster: list[dict[str, Any]], canastas: list[Canasta],
                     stats: dict[int, dict[str, Any]], final: int | None) -> list[str]:
    """Motivos por los que el acta leída no cuadra con el marcador final (vacío si cuadra)."""
    problemas = []
    if final is None:
        problemas.append("no se conoce el marcador final")
    if len(stats) != len(roster):
        problemas.append("hay dorsales repetidos en el acta")
    fuera = sorted({c.dorsal for c in canastas} - set(stats))
    if fuera:
        problemas.append(f"canastas de dorsales que no están en la plantilla del acta: {fuera}")
    raras = [c.puntos for c in canastas if c.puntos not in (1, 2, 3)]
    if raras:
        problemas.append(f"saltos del tanteo que no son de 1, 2 o 3 puntos: {raras}")
    suma = sum(s["puntos"] for s in stats.values())
    if final is not None and suma != final:
        problemas.append(f"la suma de los jugadores da {suma} y el marcador final es {final}")
    return problemas


def problemas_cuartos(canastas: list[Canasta], stats: dict[int, dict[str, Any]],
                      cuartos: list[tuple[int, int]], final: int | None, final_rival: int | None) -> list[str]:
    """Motivos por los que los parciales del acta no cuadran con su tanteo arrastrado (vacío si cuadran).
    La tinta es una prueba independiente: si los parciales están mal pero sus cortes caen justo en
    una canasta, las sumas por periodo cuadrarían igual y solo el color lo delata."""
    problemas = []
    nuestros, suyos = [c for c, _ in cuartos], [r for _, r in cuartos]
    if final is not None and sum(nuestros) != final:
        problemas.append(f"los parciales suman {sum(nuestros)} y el marcador final es {final}")
    if final_rival is not None and sum(suyos) != final_rival:
        problemas.append(f"los parciales del rival suman {sum(suyos)} y su marcador final es {final_rival}")
    for k, parcial in enumerate(nuestros):
        suma = sum(s["porCuarto"][k] for s in stats.values())
        if suma != parcial:
            problemas.append(f"en el periodo {k + 1} los jugadores suman {suma} y el parcial es {parcial}")
    cortes = list(accumulate(nuestros))
    otra_tinta = []
    for c in canastas:
        k = periodo_de(c.marcador, cortes)
        if k is not None and k < 4 and c.color in (ROJO, AZUL) and c.color != (ROJO if k % 2 == 0 else AZUL):
            otra_tinta.append(c.marcador)
    if otra_tinta:
        problemas.append(f"canastas con la tinta de otro periodo (tanteo {otra_tinta})")
    return problemas


def analizar_acta(acta: dict[str, Any], lado: str, puntos: int | None, puntos_rival: int | None) -> Analisis:
    """Ficha del partido de Clippers (que juegan en el lado «lado» del acta) y si cuadra con el marcador."""
    otro = "B" if lado == "A" else "A"
    canastas = acta["score"][lado]["canastas"]
    detalle: dict[str, Any] = {}
    avisos: list[str] = []

    cuartos = None
    if acta["periodos"] is None:
        avisos.append("no se leen los parciales por periodo; se omiten «cuartos» y «porCuarto»")
    else:
        i = 0 if lado == "A" else 1
        cuartos = [(p[i], p[1 - i]) for p in acta["periodos"]]
        detalle["cuartos"] = [{"clippers": c, "rival": r} for c, r in cuartos]
    stats = stats_partido(acta[lado], canastas, list(accumulate(c for c, _ in cuartos)) if cuartos else None)
    problemas = problemas_cuadre(acta[lado], canastas, stats, puntos)
    if cuartos:
        problemas += problemas_cuartos(canastas, stats, cuartos, puntos, puntos_rival)

    titulares = sum(s["titular"] for s in stats.values())
    if titulares != TITULARES:
        avisos.append(f"se leen {titulares} titulares y no {TITULARES}; se omite «titular»")
        stats = {d: {k: v for k, v in s.items() if k != "titular"} for d, s in stats.items()}

    # Tiros libres intentados: los que conceden las faltas del rival (subíndice de cada falta).
    # Por jugador no se puede: el acta no apunta quién lanzó los fallados.
    concedidos = {
        ld: sum(t for p in acta[ld] for _, t in p["faltas"]) + sum(t for _, t in acta["banquillo"][ld])
        for ld in (lado, otro)
    }
    anotados = {
        "tl": (sum(s["t1"] for s in stats.values()), concedidos[otro]),
        "tlRival": (sum(1 for c in acta["score"][otro]["canastas"] if c.puntos == 1), concedidos[lado]),
    }
    for clave, (hechos, intentos) in anotados.items():
        if hechos <= intentos:
            detalle[clave] = {"anotados": hechos, "intentos": intentos}
        else:
            avisos.append(f"«{clave}»: {hechos} tiros libres anotados y solo {intentos} concedidos en faltas; se omite")

    tiempos = acta["tiempos"].get(lado)
    if tiempos is None:
        avisos.append("no se leen los tiempos muertos; se omite «tiemposMuertos»")
    else:
        detalle["tiemposMuertos"] = tiempos
    return Analisis(stats=stats, detalle=detalle, problemas=problemas, avisos=avisos)


def jugadores_partido(stats: dict[int, dict[str, Any]]) -> list[dict[str, Any]]:
    return [{"dorsal": d, **stats[d]} for d in sorted(stats)]


def sumar_listas(a: list[int], b: list[int]) -> list[int]:
    return [x + y for x, y in zip_longest(a, b, fillvalue=0)]


def acumular(total: dict[int, dict[str, Any]], partido: dict[int, dict[str, Any]]) -> dict[int, dict[str, Any]]:
    nuevo = dict(total)
    for dorsal, s in partido.items():
        previo = total.get(dorsal) or {
            "nombreActa": s["nombreActa"], "pj": 0, "titular": 0, **{campo: 0 for campo in CAMPOS_SUMABLES},
            "faltasTipo": {}, "porCuarto": [], "maxPuntos": 0,
        }
        nuevo[dorsal] = {
            "dorsal": dorsal,
            # el acta recorta nombres (y "(CAP)" les quita sitio): nos quedamos con el más largo
            "nombreActa": max(previo["nombreActa"], s["nombreActa"], key=len),
            "pj": previo["pj"] + int(s["jugo"]),
            "titular": previo["titular"] + int(s.get("titular", False)),
            **{campo: previo[campo] + s[campo] for campo in CAMPOS_SUMABLES},
            "faltasTipo": dict(Counter(previo["faltasTipo"]) + Counter(s["faltasTipo"])),
            "porCuarto": sumar_listas(previo["porCuarto"], s.get("porCuarto", [])),
            "maxPuntos": max(previo["maxPuntos"], s["puntos"]),
        }
    return nuevo


def resumen_equipo(partidos: list[dict[str, Any]]) -> dict[str, Any]:
    """Totales del equipo en los partidos cuyo acta cuadra. Un dato que no se pudo leer en un
    partido (p. ej. los tiempos muertos) solo suma con los partidos que sí lo tienen."""
    validos = [p for p in partidos if p["cuadra"]]
    jugadores = [j for p in validos for j in p["jugadores"]]
    con_cuartos = [p["cuartos"] for p in validos if "cuartos" in p]

    def tiros_libres(clave: str) -> dict[str, int]:
        con_dato = [p[clave] for p in validos if clave in p]
        return {campo: sum(tl[campo] for tl in con_dato) for campo in ("anotados", "intentos")}

    return {
        "pj": len(validos),
        "puntos": sum(p["puntos"] for p in validos),
        "puntosRival": sum(p["puntosRival"] for p in validos),
        "porCuarto": reduce(sumar_listas, ([c["clippers"] for c in cs] for cs in con_cuartos), []),
        "porCuartoRival": reduce(sumar_listas, ([c["rival"] for c in cs] for cs in con_cuartos), []),
        "tl": tiros_libres("tl"),
        "tlRival": tiros_libres("tlRival"),
        **{campo: sum(j[campo] for j in jugadores) for campo in ("t3", "t2", "t1", "faltas")},
        "tiemposMuertos": sum(len(p["tiemposMuertos"]) for p in validos if "tiemposMuertos" in p),
    }


# --- Fechas -----------------------------------------------------------------------
@cache
def zona_madrid() -> ZoneInfo | None:
    try:
        return ZoneInfo(ZONA)
    except ZoneInfoNotFoundError:
        return None


def fecha_local(datetime_utc: str | None) -> str | None:
    """'2026-10-04 14:20:00' (UTC, como lo da Leverade) -> '2026-10-04' en hora de Madrid."""
    if not datetime_utc:
        return None
    zona = zona_madrid()
    if zona is None:
        return datetime_utc[:10]
    instante = datetime.strptime(datetime_utc, "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
    return instante.astimezone(zona).date().isoformat()


# --- Proceso por equipo --------------------------------------------------------------
def aviso(mensaje: str) -> None:
    print(f"  AVISO: {mensaje}")


def procesar_equipo(clave: str, cfg: dict[str, str]) -> ResultadoEquipo:
    team_id = cfg["team_id"]
    datos, incluidos = partidos_api(team_id, cfg["group_id"])
    nombres = nombres_equipos(incluidos)
    resultados = marcadores(incluidos)
    jugados = sorted(
        (m for m in datos
         if team_id in (m["meta"]["home_team"], m["meta"]["away_team"])
         and m["attributes"]["finished"] and m["attributes"].get("report")),
        key=lambda m: (m["attributes"]["datetime"] or "", m["id"]),
    )
    partidos: list[dict[str, Any]] = []
    jugadores: dict[int, dict[str, Any]] = {}
    analizados = descartados = actas_leidas = fallos_descarga = 0
    for m in jugados:
        es_local = m["meta"]["home_team"] == team_id
        rival_id = m["meta"]["away_team"] if es_local else m["meta"]["home_team"]
        fecha = fecha_local(m["attributes"]["datetime"])
        etiqueta = f"{clave} · {fecha} vs {nombres.get(rival_id, rival_id)} (partido {m['id']})"
        oficial = resultados.get(m["id"], {})
        partido: dict[str, Any] = {"matchId": m["id"], "fecha": fecha}
        if rival_id in nombres:
            partido["rival"] = nombres[rival_id]
        partido["local"] = es_local
        puntos, puntos_rival = oficial.get(team_id), oficial.get(rival_id)

        acta = None
        try:
            pdf, descargado = obtener_acta(m["id"], m["attributes"]["report"])
            if descargado:
                print(f"  acta {m['id']} descargada en {CACHE_ACTAS.relative_to(RAIZ).as_posix()}/")
                time.sleep(PAUSA_DESCARGA_S)
            actas_leidas += 1
            acta = parse_acta(pdf)
        except ErrorRed as e:
            fallos_descarga += 1
            aviso(f"{etiqueta}: no se pudo descargar el acta ({e}); se descarta")
        except ActaIlegible as e:
            aviso(f"{etiqueta}: acta ilegible ({e}); se descarta")

        cuadra = False
        ficha: dict[str, Any] = {}  # solo se publica si el acta cuadra
        if acta is not None:
            lado, nota = lado_clippers(acta["cabecera"], es_local)
            if nota:
                aviso(f"{etiqueta}: {nota}")
            otro = "B" if lado == "A" else "A"
            if acta["final"] is not None:
                if puntos is not None and (puntos, puntos_rival) != (acta["final"][lado], acta["final"][otro]):
                    aviso(f"{etiqueta}: el acta da {acta['final'][lado]}-{acta['final'][otro]} y la API "
                          f"{puntos}-{puntos_rival}; se toma la API")
                puntos = acta["final"][lado] if puntos is None else puntos
                puntos_rival = acta["final"][otro] if puntos_rival is None else puntos_rival
            analisis = analizar_acta(acta, lado, puntos, puntos_rival)
            cuadra = not analisis.problemas
            if cuadra:
                for nota in analisis.avisos:
                    aviso(f"{etiqueta}: {nota}")
                jugadores = acumular(jugadores, analisis.stats)
                ficha = {**analisis.detalle, "jugadores": jugadores_partido(analisis.stats)}
            else:
                aviso(f"{etiqueta}: el acta no cuadra ({'; '.join(analisis.problemas)}); "
                      "no se suma a las estadísticas")
                # Se borra de la caché para volver a descargarla en la próxima ejecución.
                ruta_acta(m["id"], m["attributes"]["report"]).unlink(missing_ok=True)

        if cuadra:
            analizados += 1
        else:
            descartados += 1
        partidos.append({**partido, "puntos": puntos, "puntosRival": puntos_rival, "cuadra": cuadra, **ficha})

    return ResultadoEquipo(
        partidos=partidos,
        jugadores=[jugadores[d] for d in sorted(jugadores)],
        analizados=analizados,
        descartados=descartados,
        actas_leidas=actas_leidas,
        fallos_descarga=fallos_descarga,
    )


# --- Resumen y salida ------------------------------------------------------------------
def dorsales_curados() -> dict[str, set[int]] | None:
    if not EQUIPOS_JSON.is_file():
        return None
    try:
        datos = json.loads(EQUIPOS_JSON.read_text(encoding="utf-8"))
        return {clave: {j["dorsal"] for j in datos[clave]["jugadores"]} for clave in EQUIPOS if clave in datos}
    except (ValueError, KeyError, TypeError) as e:
        print(f"AVISO: no se puede leer {EQUIPOS_JSON.name} ({e}); no se comparan dorsales")
        return None


def imprimir_resumen(clave: str, res: ResultadoEquipo, curados: dict[str, set[int]] | None) -> None:
    print(f"  {len(res.partidos)} partido(s) con acta: {res.analizados} sumado(s), "
          f"{res.descartados} descartado(s)")
    top = sorted(res.jugadores, key=lambda j: (-j["puntos"], j["dorsal"]))[:3]
    if top:
        print("  máximos anotadores: " + " · ".join(f"#{j['dorsal']} {j['nombreActa']} {j['puntos']}" for j in top))
    if curados is not None and clave in curados:
        faltan = [j["dorsal"] for j in res.jugadores if j["dorsal"] not in curados[clave]]
        if faltan:
            aviso(f"dorsales de las actas que no están en equipos.json › {clave}: {', '.join(map(str, faltan))}")


def escribir_json(ruta: Path, datos: dict[str, Any]) -> None:
    """Escritura atómica: o queda el fichero nuevo entero o el anterior intacto."""
    ruta.parent.mkdir(parents=True, exist_ok=True)
    temporal = ruta.with_suffix(ruta.suffix + ".tmp")
    temporal.write_text(json.dumps(datos, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(temporal, ruta)


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    if zona_madrid() is None:
        print(f"AVISO: no hay datos de zona horaria para {ZONA} (pip install tzdata); "
              "«fecha» será la fecha UTC del partido")
    curados = dorsales_curados()
    resultados: dict[str, ResultadoEquipo] = {}
    try:
        for clave, cfg in EQUIPOS.items():
            print(f"{clave} · {cfg['grupo']}")
            resultados[clave] = procesar_equipo(clave, cfg)
            imprimir_resumen(clave, resultados[clave], curados)
    except ErrorRed as e:
        print(f"ERROR de red: {e}\nNo se toca {DESTINO.name}.", file=sys.stderr)
        return 1
    fallos = sum(r.fallos_descarga for r in resultados.values())
    if fallos and not any(r.actas_leidas for r in resultados.values()):
        print(f"ERROR de red: no se ha podido descargar ninguna acta.\nNo se toca {DESTINO.name}.",
              file=sys.stderr)
        return 1

    salida = {
        "actualizado": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "fuente": FUENTE,
        "equipos": {
            clave: {"resumen": resumen_equipo(r.partidos), "partidos": r.partidos, "jugadores": r.jugadores}
            for clave, r in resultados.items()
        },
    }
    escribir_json(DESTINO, salida)
    print(f"→ {DESTINO.relative_to(RAIZ).as_posix()}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
