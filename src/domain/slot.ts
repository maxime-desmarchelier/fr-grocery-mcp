// Slots spelled out by the sites ("Lundi 26 octobre à 07h00", "Dim. 25/10 de 08h30 à 09h00"),
// turned into comparable local dates. The year, never displayed, is inferred from a reference date.

/** Local date and time (Paris time), formatted "YYYY-MM-DDTHH:MM". */
export type LocalDateTime = string;

export interface SlotTime {
  /** Site label, kept as is. */
  readonly label: string;
  readonly start: LocalDateTime | null;
  readonly end: LocalDateTime | null;
}

const MONTHS = [
  "janvier",
  "fevrier",
  "mars",
  "avril",
  "mai",
  "juin",
  "juillet",
  "aout",
  "septembre",
  "octobre",
  "novembre",
  "decembre",
];

const pad = (n: number): string => String(n).padStart(2, "0");

/** Year of the next DD/MM from the reference (a slot more than 7 days in the past is next year). */
function yearFor(month: number, day: number, reference: Date): number {
  const year = reference.getFullYear();
  const candidate = new Date(year, month - 1, day);
  const weekAgo = new Date(reference.getFullYear(), reference.getMonth(), reference.getDate() - 7);
  return candidate < weekAgo ? year + 1 : year;
}

function at(year: number, month: number, day: number, time: string | undefined): LocalDateTime | null {
  const m = time?.match(/^(\d{1,2})h(\d{2})?$/);
  if (!m) return null;
  const hours = Number(m[1]);
  const minutes = Number(m[2] ?? 0);
  if (hours > 23 || minutes > 59) return null;
  return `${year}-${pad(month)}-${pad(day)}T${pad(hours)}:${pad(minutes)}`;
}

/** Interprets a slot label; start and end are null if the format is unknown. */
export function parseSlotLabel(label: string, reference: Date): SlotTime {
  const text = label.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();
  const times = [...text.matchAll(/\b(\d{1,2}h(?:\d{2})?)\b/g)].map((m) => m[1]);

  let day: number | null = null;
  let month: number | null = null;
  const numeric = text.match(/\b(\d{1,2})\/(\d{1,2})\b/);
  const spelled = text.match(new RegExp(`\\b(\\d{1,2}) (${MONTHS.join("|")})\\b`));
  if (numeric) [day, month] = [Number(numeric[1]), Number(numeric[2])];
  else if (spelled?.[2]) [day, month] = [Number(spelled[1]), MONTHS.indexOf(spelled[2]) + 1];

  if (day === null || month === null || month < 1 || month > 12 || day < 1 || day > 31) {
    return { label, start: null, end: null };
  }
  const year = yearFor(month, day, reference);
  return { label, start: at(year, month, day, times[0]), end: at(year, month, day, times[1]) };
}
