import { createContext, useContext, useState } from 'react';

const ReviewReminderContext = createContext();
export const useReviewReminder = () => useContext(ReviewReminderContext);

// "Dejé comentarios en este video sin avisarle al editor que terminé de revisar" — vive arriba del
// Router (como UndoContext) para sobrevivir el unmount del reproductor al navegar a otra parte de
// la app. Acá solo se guarda el estado; la detección de "se fue sin avisar" (necesita useLocation,
// que exige estar dentro del Router) y el modal en sí viven en Layout.jsx.
export function ReviewReminderProvider({ children }) {
  const [pendingReview, setPendingReview] = useState(null); // { videoId, projectId, videoTitle } | null
  const clearPendingReview = () => setPendingReview(null);
  return (
    <ReviewReminderContext.Provider value={{ pendingReview, setPendingReview, clearPendingReview }}>
      {children}
    </ReviewReminderContext.Provider>
  );
}
