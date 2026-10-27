export const TIME_OF_DAY_LABELS = {
  morning:'上午', afternoon:'下午', evening:'晚上', night:'深夜'
} as const;
export type TimeOfDay = keyof typeof TIME_OF_DAY_LABELS;
export function isTimeOfDay(value:unknown):value is TimeOfDay {
  return typeof value==='string' && Object.prototype.hasOwnProperty.call(TIME_OF_DAY_LABELS,value);
}
export function normalizeTimeOfDay(value:unknown):TimeOfDay|undefined {
  if(typeof value!=='string')return undefined;
  const trimmed=value.trim();
  if(isTimeOfDay(trimmed))return trimmed;
  // Existing hand-written travel notes used the Chinese display label.
  return (Object.keys(TIME_OF_DAY_LABELS) as TimeOfDay[]).find(key=>TIME_OF_DAY_LABELS[key]===trimmed);
}
export interface TripDates {date:string;end_date?:string;time_of_day?:TimeOfDay}
/** Keep both years visible, including New Year trips. Old single-day labels are unchanged. */
export function formatTripDate(trip:TripDates):string {
  const range=trip.end_date && trip.end_date!==trip.date ? trip.date+' – '+trip.end_date : trip.date;
  return range+(trip.time_of_day?' · '+TIME_OF_DAY_LABELS[trip.time_of_day]:'');
}
/** A trip spanning New Year belongs to every year it touches. */
export function tripYears(trip:TripDates):string[] {
  const start=Number(trip.date.slice(0,4)),end=Number((trip.end_date||trip.date).slice(0,4));
  const years:string[]=[];
  for(let year=start;year<=end;year++)years.push(String(year).padStart(4,'0'));
  return years;
}
