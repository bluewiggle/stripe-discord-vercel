const timezone = "Australia/Sydney";

function partsAt(time: number) {
  return Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(time)).map(part => [part.type, part.value]));
}

export function checkoutSchedule(value: string, now = Date.now()) {
  const text = value.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  const local = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text);
  const [year, month, day] = iso
    ? [Number(iso[1]), Number(iso[2]), Number(iso[3])]
    : local ? [Number(local[3]), Number(local[2]), Number(local[1])] : [0, 0, 0];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (year < 2000 || year > 9999 || date.getUTCFullYear() !== year ||
      date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new Error("Enter a valid checkout date as DD/MM/YYYY (e.g. 28/10/2026) or YYYY-MM-DD.");
  }
  const checkoutDate = date.toISOString().slice(0, 10);
  const today = partsAt(now);
  if (checkoutDate < `${today.year}-${today.month}-${today.day}`) {
    throw new Error("Checkout date cannot be before today in Sydney.");
  }
  // Add calendar days before applying Sydney's offset, so DST is respected.
  const target = Date.UTC(year, month - 1, day + 1, 10);
  let reminderAt = target;
  for (let i = 0; i < 3; i++) {
    const p = partsAt(reminderAt);
    const observed = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
    reminderAt += target - observed;
  }
  return { checkoutDate, reminderAt };
}

export function displayCheckoutDate(value: string) {
  const [year, month, day] = value.split("-");
  return `${day}/${month}/${year}`;
}
