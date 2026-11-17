"""Juge local de Ragator : Aplomb 1 (EmpirioLabs), servi sur POST /v1/systemone au format de JEV.

Allégé pour cohabiter avec le LLM sur une carte de 16 à 24 Go : poids en 4 bits (bitsandbytes NF4),
partie vision supprimée (Ragator n'envoie que du texte), audio jamais téléchargé. Mesuré : tri (AUC)
0,74 en 4 bits comme en pleine précision, contre 0,78 pour JEV ; notes décalées d'environ +0,1 par le
4 bits (seuil 0,4 au lieu de 0,3) ; retirer la vision ne change aucune note.

Aplomb est sous licence EmpirioLabs, dans un dépôt fermé : accepter la licence sur Hugging Face, puis
saisir un jeton dans l'onglet Réglages de Ragator, qui le transmet ici (POST /v1/setup). Le modèle et
son code sont téléchargés une fois dans /models, jamais redistribués ; ce fichier n'en contient rien.

GET /health répond toujours 200 avec l'état : `needs_token`, `loading`, `ready` ou `error`.
"""
from __future__ import annotations

import json
import os
import sys
import threading
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

REPO = "empiriolabsai/aplomb-1"
MODEL_DIR = Path(os.environ.get("APLOMB_DIR", "/models/aplomb-1"))
PORT = int(os.environ.get("PORT", "8000"))
AUDIO = ["audio_encoder/*", "audio_notes/*", "audio_attach.safetensors", "audio_config.json"]

STATE = {"state": "needs_token", "message": "jeton Hugging Face attendu (onglet Réglages de Ragator)"}
MODEL: dict = {}
LOCK = threading.Lock()  # une décision à la fois : la carte est partagée avec le LLM
LOADING = threading.Lock()


def downloaded() -> bool:
    return (MODEL_DIR / "edm_config.json").is_file() and (MODEL_DIR / "run_aplomb.py").is_file()


def load(token: str | None) -> None:
    import torch
    from huggingface_hub import snapshot_download
    from transformers import BitsAndBytesConfig

    if not downloaded():
        STATE.update(state="loading", message="téléchargement d'Aplomb (~10 Go)")
        snapshot_download(REPO, local_dir=MODEL_DIR, token=token or None, ignore_patterns=AUDIO)
    STATE.update(state="loading", message="chargement sur la carte graphique")
    sys.path.insert(0, str(MODEL_DIR))
    from aplomb.adapter import DecisionAdapter
    from aplomb.schema import RequestError
    from run_aplomb import decide

    # La tête de sortie, lue pour les probabilités, reste en pleine précision.
    quant = BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type="nf4", bnb_4bit_compute_dtype=torch.bfloat16,
                               llm_int8_skip_modules=["lm_head", "visual", "model.visual"])
    # device=None : un modèle quantifié est placé au chargement, un .to() ensuite est interdit.
    adapter = DecisionAdapter(str(MODEL_DIR), device=None, model_kwargs={"device_map": {"": 0}, "quantization_config": quant})
    del adapter.model.model.visual
    adapter.model.model.visual = None
    torch.cuda.empty_cache()
    config = json.loads((MODEL_DIR / "edm_config.json").read_text(encoding="utf-8"))
    MODEL.update(adapter=adapter, decide=decide, error=RequestError, config=config, torch=torch)

    # Échauffement : Triton compile les noyaux d'attention linéaire au premier appel (~20-30 s) ; une
    # décision d'un extrait de taille habituelle épargne ce délai à la première question.
    STATE.update(state="loading", message="échauffement")
    answer({"state": "question: Quand utilisent-ils une visseuse ?\nvideo_title: Atelier\nexcerpts:\n"
            + "[s1 00:10] PAROLE : On fixe les tasseaux sur le mur de l'atelier avec la visseuse. " * 120,
            "questions": {"decision": {"type": "noul", "instructions": "Do the `excerpts` answer the `question`?"}}})
    torch.cuda.empty_cache()
    STATE.update(state="ready", message=f"{torch.cuda.memory_reserved() / 1e9:.1f} Go réservés sur la carte")
    print(f"Aplomb prêt sur le port {PORT} : {STATE['message']}", flush=True)


def start(token: str | None) -> bool:
    """Lance le chargement en arrière-plan ; False s'il est déjà en cours ou fait."""
    if STATE["state"] in ("loading", "ready") or not LOADING.acquire(blocking=False):
        return False

    def run():
        try:
            load(token)
        except Exception as exc:  # jeton refusé, licence non acceptée, carte absente…
            traceback.print_exc()
            gated = "401" in str(exc) or "403" in str(exc) or "gated" in str(exc).lower()
            STATE.update(state="needs_token" if gated and not downloaded() else "error",
                         message=("jeton refusé : accepter la licence d'Aplomb sur Hugging Face avec ce compte" if gated
                                  else f"{type(exc).__name__} : {exc}"))
        finally:
            LOADING.release()

    threading.Thread(target=run, daemon=True).start()
    return True


def answer(body: dict) -> dict:
    if not isinstance(body, dict) or "state" not in body or not isinstance(body.get("questions"), dict):
        raise MODEL["error"]("the body needs a state and a questions object")
    config = MODEL["config"]
    with LOCK, MODEL["torch"].inference_mode():
        return MODEL["decide"](MODEL["adapter"], body, config.get("temperatures", {}), debias=True, batch=8,
                               abstain_bias=float(config.get("abstain_bias", 0.0) or 0.0))


class Handler(BaseHTTPRequestHandler):
    def send(self, code: int, obj: dict) -> None:
        data = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def body(self):
        return json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"null")

    def do_GET(self):
        if self.path == "/health":
            return self.send(200, dict(STATE))
        self.send(404, {"error": "not found"})

    def do_POST(self):
        if self.path == "/v1/setup":
            try:
                token = (self.body() or {}).get("hf_token")
            except ValueError:
                return self.send(400, {"error": "invalid json"})
            if STATE["state"] == "error":
                STATE.update(state="needs_token")
            start(token if isinstance(token, str) else None)
            return self.send(200, dict(STATE))
        if self.path not in ("/v1/systemone", "/v1/decisions"):
            return self.send(404, {"error": "not found"})
        if STATE["state"] != "ready":
            return self.send(503, {"error": f"Aplomb pas prêt : {STATE['message']}"})
        try:
            result = answer(self.body())
        except (MODEL["error"], ValueError) as exc:
            return self.send(400, {"error": str(exc)})
        except Exception:
            traceback.print_exc()
            return self.send(500, {"error": "internal error"})
        self.send(200, result)

    def log_message(self, *args):
        pass


# Déjà téléchargé (redémarrage) : chargé sans jeton. Sinon, attente du jeton envoyé par Ragator.
if downloaded():
    start(None)
print(f"Juge local sur le port {PORT} : {STATE['message']}", flush=True)
ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
