# Juge local de Ragator (mode local) : Aplomb 1 en 4 bits, sans vision ni audio (voir serve.py).
# Versions figées : celles du banc des juges. flash-linear-attention : noyaux GPU des couches d'attention
# linéaire d'Aplomb, compilés par Triton au premier appel (d'où gcc) ; mesuré : 0,14 s par décision
# contre 0,23 s avec le code PyTorch générique, mêmes notes.
FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends gcc libc6-dev && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir torch==2.14.1 torchvision==0.29.1 --index-url https://download.pytorch.org/whl/cu130
RUN pip install --no-cache-dir transformers==5.19.0 accelerate==1.15.0 bitsandbytes==0.50.2 \
      flash-linear-attention==0.5.2 huggingface-hub==2.2.0
WORKDIR /app
COPY serve.py .
# Noyaux compilés gardés avec les modèles : un redémarrage ne les recompile pas.
ENV PYTHONUNBUFFERED=1 HF_HUB_DISABLE_TELEMETRY=1 TRITON_CACHE_DIR=/models/triton-cache
EXPOSE 8000
HEALTHCHECK --interval=15s --timeout=5s --start-period=60s --retries=5 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=4)"
CMD ["python", "serve.py"]
