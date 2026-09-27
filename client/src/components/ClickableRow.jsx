// Reemplaza <div className="list-row" onClick={...}> por un <button> real — encontrado en un
// análisis de accesibilidad: 13 filas clickeables en 5 archivos usaban un div con onClick, que no
// se puede alcanzar con Tab ni activar con Enter/Espacio. Un botón hace todo eso gratis, sin
// agregar role/tabIndex/onKeyDown a mano en cada uso. La clase .list-row ya define su propio
// border/background/cursor (ver index.css), así que solo hace falta resetear lo que un <button>
// trae de fábrica y un <div> no: ancho, alineación de texto y tipografía heredada.
export default function ClickableRow({ onClick, children, className = 'list-row', style, ...props }) {
  return (
    <button type="button" onClick={onClick} className={className}
      style={{ width: '100%', textAlign: 'left', font: 'inherit', color: 'inherit', ...style }}
      {...props}>
      {children}
    </button>
  );
}
