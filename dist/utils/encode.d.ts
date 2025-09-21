/**
 * Helper function to format dates for iCalendar.
 * @param date - The date to format.
 * @param utc - Whether to format in UTC (default: true)
 * @returns A formatted date string.
 */
export declare const formatDate: (date: Date, utc?: boolean) => string;
/**
 * Helper function to format dates for all-day iCalendar events.
 * @param date - The date to format.
 * @returns A formatted date-only string (YYYYMMDD).
 */
export declare const formatDateOnly: (date: Date) => string;
