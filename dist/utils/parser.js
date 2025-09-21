"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseTodos = exports.parseEvents = exports.parseCalendars = void 0;
const fast_xml_parser_1 = require("fast-xml-parser");
const ical_js_1 = __importDefault(require("ical.js"));
const normalizeParam = (value) => {
    if (Array.isArray(value)) {
        return value[0];
    }
    return value;
};
function parseRecurrence(recur) {
    const freqMap = {
        DAILY: "DAILY",
        WEEKLY: "WEEKLY",
        MONTHLY: "MONTHLY",
        YEARLY: "YEARLY",
    };
    const freq = freqMap[recur.freq] || undefined;
    const byday = recur.parts.BYDAY
        ? recur.parts.BYDAY.map((day) => day)
        : undefined;
    const bymonthday = recur.parts.BYMONTHDAY
        ? recur.parts.BYMONTHDAY.map((day) => day)
        : undefined;
    const bymonth = recur.parts.BYMONTH
        ? recur.parts.BYMONTH.map((month) => month)
        : undefined;
    return {
        freq,
        interval: recur.interval,
        count: recur.count ? recur.count : undefined,
        until: recur.until ? recur.until.toJSDate() : undefined,
        byday,
        bymonthday,
        bymonth,
    };
}
const toArray = (value) => Array.isArray(value) ? value : value ? [value] : [];
const parseCalendars = async (responseData, baseUrl) => {
    var _a, _b, _c;
    const calendars = [];
    const parser = new fast_xml_parser_1.XMLParser({
        removeNSPrefix: true,
        ignoreAttributes: false,
        attributeNamePrefix: "",
    });
    const jsonData = parser.parse(responseData);
    const responses = toArray((_a = jsonData === null || jsonData === void 0 ? void 0 : jsonData.multistatus) === null || _a === void 0 ? void 0 : _a.response);
    for (const res of responses) {
        const propstats = toArray(res === null || res === void 0 ? void 0 : res.propstat);
        const okPropstat = propstats.find((p) => typeof (p === null || p === void 0 ? void 0 : p.status) === "string" &&
            p.status.toLowerCase().includes("200 ok"));
        if (!okPropstat)
            continue;
        const prop = okPropstat.prop;
        const compArray = toArray((_b = prop === null || prop === void 0 ? void 0 : prop["supported-calendar-component-set"]) === null || _b === void 0 ? void 0 : _b.comp);
        const supportedComponents = compArray
            .map((c) => c.name)
            .filter((name) => [
            "VEVENT",
            "VTODO",
            "VJOURNAL",
            "VFREEBUSY",
            "VTIMEZONE",
            "VAVAILABILITY",
        ].includes(name));
        if (!supportedComponents.includes("VEVENT") &&
            !supportedComponents.includes("VTODO"))
            continue;
        calendars.push({
            displayName: (_c = prop === null || prop === void 0 ? void 0 : prop.displayname) !== null && _c !== void 0 ? _c : "",
            url: baseUrl ? new URL(res.href, baseUrl).toString() : res.href,
            ctag: prop === null || prop === void 0 ? void 0 : prop.getctag,
            supportedComponents,
        });
    }
    return calendars;
};
exports.parseCalendars = parseCalendars;
const parseEvents = async (responseData, baseUrl) => {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j;
    const events = [];
    const parser = new fast_xml_parser_1.XMLParser({ removeNSPrefix: true });
    const jsonData = parser.parse(responseData);
    let response = (_a = jsonData["multistatus"]) === null || _a === void 0 ? void 0 : _a["response"];
    if (!response)
        return events;
    if (!Array.isArray(response))
        response = [response];
    for (const obj of response) {
        const eventData = (_b = obj["propstat"]) === null || _b === void 0 ? void 0 : _b["prop"];
        if (!eventData)
            continue;
        const rawCalendarData = eventData["calendar-data"];
        if (!rawCalendarData)
            continue;
        const cleanedCalendarData = rawCalendarData.replace(/&#13;/g, "\r");
        try {
            const jcalData = ical_js_1.default.parse(cleanedCalendarData);
            const vcalendar = new ical_js_1.default.Component(jcalData);
            const vevents = vcalendar.getAllSubcomponents("vevent");
            for (const vevent of vevents) {
                const icalEvent = new ical_js_1.default.Event(vevent);
                const dtStartProp = vevent.getFirstProperty("dtstart");
                const dtEndProp = vevent.getFirstProperty("dtend");
                const isWholeDay = icalEvent.startDate.isDate;
                const startDate = icalEvent.startDate.toJSDate();
                const endDate = (_d = (_c = icalEvent.endDate) === null || _c === void 0 ? void 0 : _c.toJSDate()) !== null && _d !== void 0 ? _d : startDate;
                const adjustedEnd = isWholeDay ? new Date(endDate.getTime()) : endDate;
                const startTzid = normalizeParam(dtStartProp === null || dtStartProp === void 0 ? void 0 : dtStartProp.getParameter("tzid"));
                const endTzid = normalizeParam(dtEndProp === null || dtEndProp === void 0 ? void 0 : dtEndProp.getParameter("tzid"));
                const rruleProp = vevent.getFirstProperty("rrule");
                let recurrenceRule;
                if (rruleProp) {
                    const rruleValue = rruleProp.getFirstValue();
                    if (rruleValue) {
                        const recur = ical_js_1.default.Recur.fromString(rruleValue.toString());
                        recurrenceRule = parseRecurrence(recur);
                    }
                }
                const alarms = [];
                const valarms = vevent.getAllSubcomponents("valarm") || [];
                for (const valarm of valarms) {
                    const action = valarm.getFirstPropertyValue("action");
                    const trigger = (_e = valarm.getFirstPropertyValue("trigger")) === null || _e === void 0 ? void 0 : _e.toString();
                    if (!action || !trigger)
                        continue;
                    if (action === "DISPLAY") {
                        alarms.push({
                            action: "DISPLAY",
                            trigger,
                            description: (_f = valarm
                                .getFirstPropertyValue("description")) === null || _f === void 0 ? void 0 : _f.toString(),
                        });
                    }
                    else if (action === "EMAIL") {
                        const attendees = ((_g = valarm
                            .getAllProperties("attendee")) === null || _g === void 0 ? void 0 : _g.map((p) => p.getFirstValue()).filter((v) => typeof v === "string")) || [];
                        alarms.push({
                            action: "EMAIL",
                            trigger,
                            description: (_h = valarm
                                .getFirstPropertyValue("description")) === null || _h === void 0 ? void 0 : _h.toString(),
                            summary: (_j = valarm.getFirstPropertyValue("summary")) === null || _j === void 0 ? void 0 : _j.toString(),
                            attendees,
                        });
                    }
                    else if (action === "AUDIO") {
                        alarms.push({ action: "AUDIO", trigger });
                    }
                }
                events.push({
                    uid: icalEvent.uid,
                    summary: icalEvent.summary || "Untitled Event",
                    start: startDate,
                    end: adjustedEnd,
                    description: icalEvent.description || undefined,
                    location: icalEvent.location || undefined,
                    etag: eventData["getetag"] || "",
                    href: baseUrl
                        ? new URL(obj["href"], baseUrl).toString()
                        : obj["href"],
                    wholeDay: isWholeDay,
                    recurrenceRule,
                    startTzid,
                    endTzid,
                    alarms,
                });
            }
        }
        catch (error) {
            console.error("Error parsing event data:", error);
        }
    }
    return events;
};
exports.parseEvents = parseEvents;
const parseTodos = async (responseData, baseUrl) => {
    var _a, _b, _c, _d, _e, _f, _g;
    const todos = [];
    const parser = new fast_xml_parser_1.XMLParser({ removeNSPrefix: true });
    const jsonData = parser.parse(responseData);
    let response = (_a = jsonData["multistatus"]) === null || _a === void 0 ? void 0 : _a["response"];
    if (!response)
        return todos;
    if (!Array.isArray(response))
        response = [response];
    for (const obj of response) {
        const todoData = (_b = obj["propstat"]) === null || _b === void 0 ? void 0 : _b["prop"];
        if (!todoData)
            continue;
        const rawCalendarData = todoData["calendar-data"];
        if (!rawCalendarData)
            continue;
        const cleanedCalendarData = rawCalendarData.replace(/&#13;/g, "\r\n");
        try {
            const jcalData = ical_js_1.default.parse(cleanedCalendarData);
            const vcalendar = new ical_js_1.default.Component(jcalData);
            const vtodos = vcalendar.getAllSubcomponents("vtodo");
            for (const vtodo of vtodos) {
                const uid = vtodo.getFirstPropertyValue("uid");
                const summary = vtodo.getFirstPropertyValue("summary") || "Untitled Todo";
                const description = vtodo.getFirstPropertyValue("description");
                const location = vtodo.getFirstPropertyValue("location");
                const status = vtodo.getFirstPropertyValue("status");
                const sortOrderRaw = vtodo.getFirstPropertyValue("x-apple-sort-order");
                const sortOrder = sortOrderRaw !== undefined && sortOrderRaw !== null
                    ? Number(sortOrderRaw)
                    : undefined;
                const dtStartProp = vtodo.getFirstProperty("dtstart");
                const dueProp = vtodo.getFirstProperty("due");
                const completedProp = vtodo.getFirstProperty("completed");
                const start = dtStartProp
                    ? dtStartProp.getFirstValue().toJSDate()
                    : undefined;
                const due = dueProp
                    ? dueProp.getFirstValue().toJSDate()
                    : undefined;
                const completed = completedProp
                    ? completedProp.getFirstValue().toJSDate()
                    : undefined;
                const alarms = [];
                const valarms = vtodo.getAllSubcomponents("valarm") || [];
                for (const valarm of valarms) {
                    const action = valarm.getFirstPropertyValue("action");
                    const trigger = (_c = valarm.getFirstPropertyValue("trigger")) === null || _c === void 0 ? void 0 : _c.toString();
                    if (!action || !trigger)
                        continue;
                    if (action === "DISPLAY") {
                        alarms.push({
                            action: "DISPLAY",
                            trigger,
                            description: (_d = valarm
                                .getFirstPropertyValue("description")) === null || _d === void 0 ? void 0 : _d.toString(),
                        });
                    }
                    else if (action === "EMAIL") {
                        const attendees = ((_e = valarm
                            .getAllProperties("attendee")) === null || _e === void 0 ? void 0 : _e.map((p) => p.getFirstValue()).filter((v) => typeof v === "string")) || [];
                        alarms.push({
                            action: "EMAIL",
                            trigger,
                            description: (_f = valarm
                                .getFirstPropertyValue("description")) === null || _f === void 0 ? void 0 : _f.toString(),
                            summary: (_g = valarm.getFirstPropertyValue("summary")) === null || _g === void 0 ? void 0 : _g.toString(),
                            attendees,
                        });
                    }
                    else if (action === "AUDIO") {
                        alarms.push({ action: "AUDIO", trigger });
                    }
                }
                todos.push({
                    uid,
                    summary,
                    start,
                    due,
                    completed,
                    status,
                    description,
                    location,
                    etag: todoData["getetag"] || "",
                    href: baseUrl
                        ? new URL(obj["href"], baseUrl).toString()
                        : obj["href"],
                    alarms,
                    sortOrder,
                });
            }
        }
        catch (error) {
            console.error("Error parsing todo data:", error);
        }
    }
    return todos;
};
exports.parseTodos = parseTodos;
//# sourceMappingURL=parser.js.map