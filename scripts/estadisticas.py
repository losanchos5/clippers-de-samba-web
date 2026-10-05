"""Estadísticas por jugador de los Clippers de Samba a partir de las actas oficiales.

Lee los partidos de la API pública de Leverade, descarga el acta (PDF) de cada partido
terminado y saca de ella, para cada dorsal, puntos, tiros anotados (1, 2 y 3) y faltas.
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
from dataclasses import dataclass
from datetime import datetime, timezone
from functools import cache
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

try:
    import fitz  # PyMuPDF
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
FOUL_RE = re.compile(r"^(P|U|T|D|C|B|F|GD)[0-9C]*$")
FINAL_RE = re.compile(r"Resultado Final.*?A\s*(\d+).*?B\s*(\d+)", re.S)
CAMPOS_SUMABLES = ("pj", "puntos", "t1", "t2", "t3", "faltas")

Palabra = tuple[float, float, float, float, str, int, int, int]


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


def parse_roster(words: list[Palabra], y0: float, y1: float) -> list[dict[str, Any]]:
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
        played = any(w[4] == "X" and 145 <= w[0] < 158 for w in ws_)
        fouls = [w[4] for w in ws_ if 160 <= w[0] < 245 and FOUL_RE.match(w[4])]
        name = " ".join(t for t in name_tokens if t).replace("(CAP) ", "").strip()
        players.append({"dorsal": int(num_tokens[0]), "nombre": name, "jugo": played, "faltas": len(fouls)})
    return players


def parse_running_score(words: list[Palabra]) -> dict[str, dict[str, Any]]:
    """Tanteo arrastrado: total de cada lado y lista de canastas (dorsal, puntos)."""
    marks: dict[str, list[tuple[int, int]]] = {"A": [], "B": []}
    ints = [w for w in words if w[4].isdigit()]
    for blk in range(4):
        ax, bx = A_SCORE_X[blk], B_SCORE_X[blk]
        for w in ints:
            if not near(w[0], ax, 4):
                continue
            y, n = w[1], int(w[4])
            for v in ints:
                if abs(v[1] - y) <= 4 and near(v[0], ax - 18, 8):
                    marks["A"].append((n, int(v[4])))
                if abs(v[1] - y) <= 4 and near(v[0], bx + 17, 9):
                    marks["B"].append((n, int(v[4])))
    out = {}
    for side, ms in marks.items():
        prev, pts = 0, []
        for n, dorsal in sorted(set(ms)):
            pts.append((dorsal, n - prev))
            prev = n
        out[side] = {"total": prev, "canastas": pts}
    return out


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
    except (RuntimeError, ValueError, IndexError) as e:
        raise ActaIlegible(f"PDF no válido ({e})") from e
    heads = sorted(w[1] for w in words if w[4] == "Jugadores")
    trainers = sorted(w[1] for w in words if w[4] == "Entrenador")
    if len(heads) < 2 or len(trainers) < 2:
        raise ActaIlegible("no se encuentran las dos tablas de jugadores")
    final = FINAL_RE.search(text)
    try:
        return {
            "A": parse_roster(words, heads[0] + 5, trainers[0] - 2),
            "B": parse_roster(words, heads[1] + 5, trainers[1] - 2),
            "score": parse_running_score(words),
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


def stats_partido(roster: list[dict[str, Any]], canastas: list[tuple[int, int]]) -> dict[int, dict[str, Any]]:
    out: dict[int, dict[str, Any]] = {}
    for p in roster:
        tiros = [pts for dorsal, pts in canastas if dorsal == p["dorsal"]]
        out[p["dorsal"]] = {
            "nombreActa": p["nombre"], "pj": int(p["jugo"]), "puntos": sum(tiros),
            "t1": tiros.count(1), "t2": tiros.count(2), "t3": tiros.count(3), "faltas": p["faltas"],
        }
    return out


def problemas_cuadre(roster: list[dict[str, Any]], canastas: list[tuple[int, int]],
                     stats: dict[int, dict[str, Any]], final: int | None) -> list[str]:
    """Motivos por los que el acta leída no cuadra con el marcador final (vacío si cuadra)."""
    problemas = []
    if final is None:
        problemas.append("no se conoce el marcador final")
    if len(stats) != len(roster):
        problemas.append("hay dorsales repetidos en el acta")
    fuera = sorted({d for d, _ in canastas} - set(stats))
    if fuera:
        problemas.append(f"canastas de dorsales que no están en la plantilla del acta: {fuera}")
    raras = [pts for _, pts in canastas if pts not in (1, 2, 3)]
    if raras:
        problemas.append(f"saltos del tanteo que no son de 1, 2 o 3 puntos: {raras}")
    suma = sum(s["puntos"] for s in stats.values())
    if final is not None and suma != final:
        problemas.append(f"la suma de los jugadores da {suma} y el marcador final es {final}")
    return problemas


def acumular(total: dict[int, dict[str, Any]], partido: dict[int, dict[str, Any]]) -> dict[int, dict[str, Any]]:
    nuevo = dict(total)
    for dorsal, s in partido.items():
        previo = total.get(dorsal)
        if previo is None:
            nuevo[dorsal] = {"dorsal": dorsal, **s}
            continue
        nuevo[dorsal] = {
            "dorsal": dorsal,
            # el acta recorta nombres (y "(CAP)" les quita sitio): nos quedamos con el más largo
            "nombreActa": max(previo["nombreActa"], s["nombreActa"], key=len),
            **{campo: previo[campo] + s[campo] for campo in CAMPOS_SUMABLES},
        }
    return nuevo


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
            canastas = acta["score"][lado]["canastas"]
            stats = stats_partido(acta[lado], canastas)
            problemas = problemas_cuadre(acta[lado], canastas, stats, puntos)
            cuadra = not problemas
            if cuadra:
                jugadores = acumular(jugadores, stats)
            else:
                aviso(f"{etiqueta}: el acta no cuadra ({'; '.join(problemas)}); no se suma a las estadísticas")
                # Se borra de la caché para volver a descargarla en la próxima ejecución.
                ruta_acta(m["id"], m["attributes"]["report"]).unlink(missing_ok=True)

        if cuadra:
            analizados += 1
        else:
            descartados += 1
        partidos.append({**partido, "puntos": puntos, "puntosRival": puntos_rival, "cuadra": cuadra})

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
        "equipos": {clave: {"partidos": r.partidos, "jugadores": r.jugadores} for clave, r in resultados.items()},
    }
    escribir_json(DESTINO, salida)
    print(f"→ {DESTINO.relative_to(RAIZ).as_posix()}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
