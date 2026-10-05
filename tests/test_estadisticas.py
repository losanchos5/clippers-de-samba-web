"""Contrato del lector de actas (scripts/estadisticas.py) con dos actas reales de la liga.

Los valores esperados se han comprobado a mano sobre cada PDF (tanteo arrastrado, cuadro de
parciales, círculos de la columna «Entr», subíndices de las faltas y cuadro de tiempos muertos),
no copiando lo que devuelve el script.
  python -m unittest discover -s tests -p "test_*.py"
"""

import importlib.util
import sys
import unittest
from pathlib import Path

AQUI = Path(__file__).resolve().parent
ACTA_A_J1 = AQUI / "fixtures" / "actas" / "a-j1-clippers-paterna-145644159.pdf"  # Clippers A 60-42 Paterna, en casa
ACTA_B_J1 = AQUI / "fixtures" / "actas" / "b-j1-narovella-clippers-145644524.pdf"  # Narovella B 35-40 Clippers B


def cargar_script():
    spec = importlib.util.spec_from_file_location("estadisticas", AQUI.parent / "scripts" / "estadisticas.py")
    modulo = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = modulo  # dataclasses busca aquí el módulo de sus clases
    sys.dont_write_bytecode = True  # scripts/__pycache__ está en git: que los tests no lo reescriban
    spec.loader.exec_module(modulo)
    return modulo


est = cargar_script()


def cuartos(analisis):
    return [(c["clippers"], c["rival"]) for c in analisis.detalle["cuartos"]]


def titulares(analisis):
    return {dorsal for dorsal, s in analisis.stats.items() if s["titular"]}


class ActaClippersLocal(unittest.TestCase):
    """Jornada 1 de Clippers A: juega en casa, así que es el equipo A del acta."""

    @classmethod
    def setUpClass(cls):
        cls.acta = est.parse_acta(ACTA_A_J1.read_bytes())
        cls.analisis = est.analizar_acta(cls.acta, "A", 60, 42)

    def test_ficha_del_partido(self):
        a = self.analisis
        self.assertEqual(a.problemas, [])
        self.assertEqual(sum(s["puntos"] for s in a.stats.values()), 60)
        self.assertEqual(cuartos(a), [(19, 10), (10, 11), (19, 8), (12, 13)])
        self.assertEqual(a.stats[2]["puntos"], 26)
        self.assertEqual(a.stats[2]["porCuarto"], [6, 2, 12, 6])
        self.assertEqual(titulares(a), {0, 2, 3, 13, 24})
        # intentos = subíndices de las faltas del rival (U2, P2, P2, P3+P2, U2) y al revés
        self.assertEqual(a.detalle["tl"], {"anotados": 5, "intentos": 13})
        self.assertEqual(a.detalle["tlRival"], {"anotados": 6, "intentos": 14})

    def test_tiempos_muertos_por_fila_y_tinta(self):
        # Clippers no pidió ninguno (casillas tachadas). Paterna, el lado B, sí: fila de la
        # 1.ª parte en rojo (min 3) y azul (min 8), y fila de la 2.ª parte en rojo (min 3).
        self.assertEqual(self.analisis.detalle["tiemposMuertos"], [])
        paterna = est.analizar_acta(self.acta, "B", 42, 60)
        self.assertEqual(paterna.detalle["tiemposMuertos"], [
            {"periodo": "1", "minuto": 3}, {"periodo": "2", "minuto": 8}, {"periodo": "3", "minuto": 3},
        ])

    def test_parciales_que_no_casan_con_el_tanteo_descartan_el_acta(self):
        # Los dos cambios mantienen 29 al descanso y 60 al final: solo puede fallar el reparto por periodo.
        score = self.acta["score"]
        sin_tinta = {**score, "A": {**score["A"], "canastas": [c._replace(color=None) for c in score["A"]["canastas"]]}}
        casos = {
            "el 1.º acaba en 18, que no es ninguna canasta (acta sin tinta de color)":
                {"periodos": [(18, 10), (11, 11), (19, 8), (12, 13)], "score": sin_tinta},
            "1.º y 2.º cambiados: el corte en 10 sí es canasta y solo la tinta lo delata":
                {"periodos": [(10, 10), (19, 11), (19, 8), (12, 13)]},
        }
        for caso, cambios in casos.items():
            with self.subTest(caso):
                self.assertNotEqual(est.analizar_acta({**self.acta, **cambios}, "A", 60, 42).problemas, [])


class ActaClippersVisitante(unittest.TestCase):
    """Jornada 1 de Clippers B: juega fuera, así que es el equipo B del acta."""

    def test_ficha_del_partido(self):
        a = est.analizar_acta(est.parse_acta(ACTA_B_J1.read_bytes()), "B", 40, 35)
        self.assertEqual(a.problemas, [])
        self.assertEqual(sum(s["puntos"] for s in a.stats.values()), 40)
        self.assertEqual(cuartos(a), [(4, 9), (10, 6), (6, 9), (20, 11)])
        self.assertEqual(titulares(a), {1, 5, 10, 21, 25})
        self.assertEqual(a.detalle["tl"], {"anotados": 6, "intentos": 17})
        self.assertEqual(a.detalle["tlRival"], {"anotados": 6, "intentos": 10})
        # El 87 figura en el acta sin la X de «Entr»: sale en el partido, pero no suma partido jugado.
        self.assertFalse(a.stats[87]["jugo"])
        temporada = est.acumular({}, a.stats)
        self.assertEqual((temporada[13]["pj"], temporada[87]["pj"]), (1, 0))


if __name__ == "__main__":
    unittest.main()
