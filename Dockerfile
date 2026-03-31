FROM node:20-slim

# Install LibreOffice (handles every Word numbering format),
# poppler-utils (pdftotext for digital PDFs),
# tesseract (OCR for scanned PDFs - V2)
RUN apt-get update && apt-get install -y \
    libreoffice \
    poppler-utils \
    tesseract-ocr \
    tesseract-ocr-eng \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install
COPY server.js ./

EXPOSE 3000
CMD ["node", "server.js"]
