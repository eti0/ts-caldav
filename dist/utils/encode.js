"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.formatDateOnly = exports.formatDate = void 0;
/**
 * Helper function to format dates for iCalendar.
 * @param date - The date to format.
 * @param utc - Whether to format in UTC (default: true)
 * @returns A formatted date string.
 */
const formatDate = (date, utc = true) => {
    const pad = (n) => n.toString().padStart(2, "0");
    if (utc) {
        return date.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
    }
    else {
        return (date.getFullYear().toString() +
            pad(date.getMonth() + 1) +
            pad(date.getDate()) +
            "T" +
            pad(date.getHours()) +
            pad(date.getMinutes()) +
            pad(date.getSeconds()));
    }
};
exports.formatDate = formatDate;
/**
 * Helper function to format dates for all-day iCalendar events.
 * @param date - The date to format.
 * @returns A formatted date-only string (YYYYMMDD).
 */
const formatDateOnly = (date) => {
    return date.toISOString().split("T")[0].replace(/-/g, "");
};
exports.formatDateOnly = formatDateOnly;
//# sourceMappingURL=encode.js.map