import { useState, useEffect } from 'react';

export const MOBILE_BREAKPOINT = 860;

export default function useNarrowViewport(breakpoint = MOBILE_BREAKPOINT) {
  const [isNarrow, setIsNarrow] = useState(() => window.innerWidth < breakpoint);
  useEffect(() => {
    const onResize = () => setIsNarrow(window.innerWidth < breakpoint);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [breakpoint]);
  return isNarrow;
}
