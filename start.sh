#!/bin/bash
# AgencyOS - Script de inicio

echo "🎬 Iniciando AgencyOS..."

# Asegurar que JWT_SECRET esté definido (requerido para arrancar el servidor)
if [ -z "$JWT_SECRET" ]; then
  SECRET_FILE=".jwt_secret"
  if [ ! -f "$SECRET_FILE" ]; then
    node -e "console.log(require('crypto').randomBytes(48).toString('hex'))" > "$SECRET_FILE"
    echo "🔑 JWT_SECRET generado y guardado en $SECRET_FILE"
  fi
  export JWT_SECRET=$(cat "$SECRET_FILE")
fi

# Instalar dependencias del servidor
echo "📦 Instalando dependencias del servidor..."
npm install

# Instalar dependencias del cliente
echo "📦 Instalando dependencias del cliente..."
cd client && npm install && cd ..

echo ""
echo "✅ Todo listo! Iniciando app..."
echo ""
echo "👉 Abrí tu navegador en: http://localhost:3000"
echo "👤 Admin: admin@agencyos.com / admin123"
echo ""

# Iniciar servidor y cliente en paralelo
npx concurrently "npm start" "cd client && npx vite"
