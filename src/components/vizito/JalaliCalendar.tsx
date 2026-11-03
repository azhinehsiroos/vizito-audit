"use client";

import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  FA_MONTHS,
  FA_WEEKDAYS,
  firstDayOfJalaliMonth,
  jalaaliMonthLength,
  jalaliOf,
  toFa,
} from "@/lib/jalali";
import { ChevronRight, ChevronLeft } from "lucide-react";

export function JalaliCalendar({ compact = false }: { compact?: boolean }) {
  const today = useMemo(() => jalaliOf(new Date()), []);
  const [view, setView] = useState({ jy: today.jy, jm: today.jm });

  const monthLen = jalaaliMonthLength(view.jy, view.jm);
  const firstWeekday = jalaliWeekdayOf(view.jy, view.jm);

  const days = useMemo(() => {
    const arr: (number | null)[] = [];
    for (let i = 0; i < firstWeekday; i++) arr.push(null);
    for (let d = 1; d <= monthLen; d++) arr.push(d);
    return arr;
  }, [monthLen, firstWeekday]);

  const prevMonth = () => {
    setView((v) => (v.jm === 1 ? { jy: v.jy - 1, jm: 12 } : { jy: v.jy, jm: v.jm - 1 }));
  };
  const nextMonth = () => {
    setView((v) => (v.jm === 12 ? { jy: v.jy + 1, jm: 1 } : { jy: v.jy, jm: v.jm + 1 }));
  };
  const goToday = () => setView({ jy: today.jy, jm: today.jm });

  const isToday = (d: number) => view.jy === today.jy && view.jm === today.jm && d === today.jd;

  return (
    <div className={compact ? "" : "p-3"}>
      <div className="flex items-center justify-between mb-2">
        <Button variant="ghost" size="icon" onClick={prevMonth} aria-label="ماه قبل">
          <ChevronRight className="h-4 w-4" />
        </Button>
        <button onClick={goToday} className="text-sm font-semibold hover:text-primary transition-colors">
          {FA_MONTHS[view.jm - 1]} {toFa(view.jy)}
        </button>
        <Button variant="ghost" size="icon" onClick={nextMonth} aria-label="ماه بعد">
          <ChevronLeft className="h-4 w-4" />
        </Button>
      </div>
      <div className="grid grid-cols-7 gap-1 text-center">
        {FA_WEEKDAYS.map((w, i) => (
          <div
            key={w}
            className={`text-[11px] py-1 font-medium ${i === 6 ? "text-destructive/80" : "text-muted-foreground"}`}
          >
            {w}
          </div>
        ))}
        {days.map((d, i) => (
          <div key={i} className="py-0.5">
            {d !== null ? (
              <div
                className={`mx-auto w-8 h-8 flex items-center justify-center rounded-full text-xs transition-colors ${
                  isToday(d)
                    ? "bg-primary text-primary-foreground font-bold shadow"
                    : "hover:bg-accent"
                }`}
              >
                {toFa(d)}
              </div>
            ) : (
              <div className="w-8 h-8" />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function jalaliWeekdayOf(jy: number, jm: number): number {
  const g = firstDayOfJalaliMonth(jy, jm);
  return (g.getDay() + 1) % 7;
}
