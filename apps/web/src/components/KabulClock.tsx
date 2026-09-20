"use client";

import { useEffect, useState } from "react";

interface ClockValue {
  readonly date: string;
  readonly time: string;
}

function readKabulTime(): ClockValue {
  const now = new Date();
  return {
    date: new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Kabul", weekday: "short", month: "short", day: "numeric", year: "numeric" }).format(now),
    time: new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Kabul", hour: "numeric", minute: "2-digit" }).format(now)
  };
}

export function KabulClock() {
  const [value, setValue] = useState<ClockValue | null>(null);

  useEffect(() => {
    const update = () => setValue(readKabulTime());
    update();
    const timer = window.setInterval(update, 30_000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <div className="kabul-clock" aria-label="Current time in Kabul">
      <small>{value?.date ?? "Kabul time"}</small>
      <strong>{value?.time ?? "--:--"}</strong>
      <span>Kabul, Afghanistan</span>
    </div>
  );
}
