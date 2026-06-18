@echo off
echo 🎬 Iniciando AgencyOS...

echo 📦 Instalando dependencias del servidor...
call npm install

echo 📦 Instalando dependencias del cliente...
cd client
call npm install
cd ..

echo.
echo ✅ Todo listo! Iniciando app...
echo.
echo 👉 Abrí tu navegador en: http://localhost:3000
echo 👤 Admin: admin@agencyos.com / admin123
echo.

call npx concurrently "npm start" "cd client && npx vite"
