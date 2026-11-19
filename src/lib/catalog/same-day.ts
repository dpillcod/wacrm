// Same-day delivery line for the product picker's header (Mi negocio →
// shopSameDayCutoff): before the cut-off "Pida en 2 h 15 min y le llega
// HOY", after it "le llega mañana temprano". Pure, so the page can
// recompute it every minute.

export function sameDayLine(
  now: Date,
  utcOffsetHours: number,
  cutoffHour: number,
): { today: boolean; text: string } | null {
  if (!cutoffHour) return null;
  const local = new Date(now.getTime() + utcOffsetHours * 3_600_000);
  const minutes = local.getUTCHours() * 60 + local.getUTCMinutes();
  const left = cutoffHour * 60 - minutes;
  if (left <= 0) return { today: false, text: "Pida ahora y le llega mañana temprano" };
  const h = Math.floor(left / 60);
  const m = left % 60;
  const wait = h ? `${h} h${m ? ` ${m} min` : ""}` : `${m} min`;
  return { today: true, text: `Pida en ${wait} y le llega HOY` };
}
