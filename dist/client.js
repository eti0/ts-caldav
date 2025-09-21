"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CalDAVClient = void 0;
const axios_1 = __importDefault(require("axios"));
const base_64_1 = require("base-64");
const fast_xml_parser_1 = require("fast-xml-parser");
const ical_js_1 = __importDefault(require("ical.js"));
const uuid_1 = require("uuid");
const encode_1 = require("./utils/encode");
const parser_1 = require("./utils/parser");
class CalDAVClient {
    resolveUrl(path) {
        const basePath = new URL(this.baseUrl).pathname;
        if (path.startsWith(basePath) && basePath !== "/") {
            const stripped = path.substring(basePath.length);
            return stripped.startsWith("/") ? stripped : "/" + stripped;
        }
        return path;
    }
    constructor(options) {
        this.options = options;
        this.httpClient = axios_1.default.create({
            baseURL: options.baseUrl,
            headers: {
                Authorization: options.auth.type === "basic"
                    ? `Basic ${(0, base_64_1.encode)(`${options.auth.username}:${options.auth.password}`)}`
                    : `Bearer ${options.auth.accessToken}`,
                "Content-Type": "application/xml; charset=utf-8",
            },
            timeout: options.requestTimeout || 5000,
        });
        this.prodId = options.prodId || "-//ts-caldav.//CalDAV Client//EN";
        this.calendarHome = null;
        this.userPrincipal = null;
        this.requestTimeout = options.requestTimeout || 5000;
        this.baseUrl = options.baseUrl;
        if (options.logRequests) {
            this.httpClient.interceptors.request.use((request) => {
                console.log(`Request: ${request.method} ${this.baseUrl}${request.url}`);
                return request;
            });
        }
    }
    /**
     * Creates a new CalDAVClient instance and validates the provided credentials.
     * @param options - The CalDAV client options.
     * @returns A new CalDAVClient instance.
     * @throws An error if the provided credentials are invalid.
     * @example
     * ```typescript
     * const client = await CalDAVClient.create({
     *  baseUrl: "https://caldav.example.com",
     *  username: "user",
     *  password: "password",
     * });
     * ```
     */
    static async create(options) {
        var _a, _b;
        const client = new CalDAVClient(options);
        const isGoogle = (_b = (_a = options.baseUrl) === null || _a === void 0 ? void 0 : _a.includes("apidata.googleusercontent.com")) !== null && _b !== void 0 ? _b : false;
        const discoveryPath = isGoogle ? `/caldav/v2/` : "/";
        await client.validateCredentials(discoveryPath);
        await client.fetchCalendarHome();
        return client;
    }
    async validateCredentials(discoveryPath) {
        const requestBody = `
        <d:propfind xmlns:d="DAV:">
        <d:prop>
            <d:current-user-principal />
        </d:prop>
        </d:propfind>`;
        try {
            const response = await this.httpClient.request({
                method: "PROPFIND",
                url: this.resolveUrl(discoveryPath),
                data: requestBody,
                headers: {
                    Depth: "0",
                    Prefer: "return=minimal",
                },
                validateStatus: (status) => status >= 200 && status < 300,
            });
            if (!response.data.includes("current-user-principal")) {
                throw new Error("User principal not found: Unable to authenticate with the server.");
            }
            const parser = new fast_xml_parser_1.XMLParser({
                removeNSPrefix: true,
            });
            const jsonData = parser.parse(response.data, {});
            const userPrincipalPath = jsonData["multistatus"]["response"]["propstat"]["prop"]["current-user-principal"]["href"];
            this.userPrincipal = this.resolveUrl(userPrincipalPath);
        }
        catch (error) {
            throw new Error("Invalid credentials: Unable to authenticate with the server." + error);
        }
    }
    async fetchCalendarHome() {
        const requestBody = `
        <d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
        <d:prop>
            <c:calendar-home-set />
        </d:prop>
        </d:propfind>`;
        const response = await this.httpClient.request({
            method: "PROPFIND",
            url: this.userPrincipal || "",
            data: requestBody,
            headers: {
                Depth: "0",
            },
            validateStatus: (status) => status >= 200 && status < 300,
        });
        const parser = new fast_xml_parser_1.XMLParser({ removeNSPrefix: true });
        const jsonData = parser.parse(response.data);
        const calendarHomePath = jsonData["multistatus"]["response"]["propstat"]["prop"]["calendar-home-set"]["href"];
        this.calendarHome = this.resolveUrl(calendarHomePath);
        return this.calendarHome;
    }
    getCalendarHome() {
        return this.calendarHome;
    }
    /**
     * Exports the current client state to a cache object.
     * This can be used to restore the client state later without re-fetching the calendar home.
     * @returns A CalDAVClientCache object containing the current client state.
     */
    exportCache() {
        return {
            userPrincipal: this.userPrincipal,
            calendarHome: this.calendarHome,
            prodId: this.prodId,
        };
    }
    /**
     * Creates a CalDAVClient instance from a cache object.
     * This is useful for restoring a client state without re-fetching the calendar home.
     * @param options - The CalDAV client options.
     * @param cache - The cached client state.
     * @return A new CalDAVClient instance initialized with the cached state.
     * @throws An error if the cache is invalid or incomplete.
     */
    static async createFromCache(options, cache) {
        const client = new CalDAVClient(options);
        client.userPrincipal = client.resolveUrl(cache.userPrincipal);
        client.calendarHome = client.resolveUrl(cache.calendarHome);
        if (cache.prodId)
            client.prodId = cache.prodId;
        return client; // no validateCredentials / no fetchCalendarHome
    }
    /**
     * Fetches all calendars available to the authenticated user.
     * @returns An array of Calendar objects.
     * @throws An error if the calendar home is not found or if the request fails.
     */
    async getCalendars() {
        if (!this.calendarHome) {
            throw new Error("Calendar home not found.");
        }
        const requestBody = `
      <d:propfind xmlns:d="DAV:" xmlns:cs="http://calendarserver.org/ns/" xmlns:c="urn:ietf:params:xml:ns:caldav">
        <d:prop>
          <d:resourcetype />
          <d:displayname />
          <cs:getctag />
          <c:supported-calendar-component-set />
        </d:prop>
      </d:propfind>`;
        const response = await this.httpClient.request({
            method: "PROPFIND",
            url: this.calendarHome,
            data: requestBody,
            headers: {
                Depth: "1",
            },
            validateStatus: (status) => status >= 200 && status < 300,
        });
        const calendars = await (0, parser_1.parseCalendars)(response.data);
        return calendars.map((cal) => ({
            ...cal,
            url: this.resolveUrl(cal.url),
        }));
    }
    /**
     * Fetches all events from a specific calendar.
     * @param calendarUrl - The URL of the calendar to fetch events from.
     * @param options - Optional parameters for fetching events.
     * @returns An array of Event objects.
     */
    async getEvents(calendarUrl, options) {
        return this.getComponents(calendarUrl, "VEVENT", parser_1.parseEvents, options);
    }
    /**
     * Fetches all todos from a specific calendar.
     * @param calendarUrl - The URL of the calendar to fetch todos from.
     * @param options - Optional parameters for fetching todos.
     * @returns An array of Todo objects.
     */
    async getTodos(calendarUrl, options) {
        return this.getComponents(calendarUrl, "VTODO", parser_1.parseTodos, {
            all: true,
            ...options,
        });
    }
    async getComponents(calendarUrl, component, parseFn, options) {
        const now = new Date();
        const defaultEnd = new Date(now.getTime() + 3 * 7 * 24 * 60 * 60 * 1000);
        const { start = now, end = defaultEnd, all } = options || {};
        const timeRangeFilter = start && end && !all
            ? `<c:comp-filter name="${component}">
             <c:time-range start="${(0, encode_1.formatDate)(start)}" end="${(0, encode_1.formatDate)(end)}" />
           </c:comp-filter>`
            : `<c:comp-filter name="${component}" />`;
        const calendarData = start && end && !all && component === "VEVENT"
            ? ` <c:calendar-data>
            <c:expand start="${(0, encode_1.formatDate)(start)}" end="${(0, encode_1.formatDate)(end)}"/>
          </c:calendar-data>`
            : `<c:calendar-data />`;
        const requestBody = `
      <c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
        <d:prop>
            <d:getetag />
            ${calendarData}
        </d:prop>
        <c:filter>
            <c:comp-filter name="VCALENDAR">
            ${timeRangeFilter}
            </c:comp-filter>
        </c:filter>
      </c:calendar-query>`;
        try {
            const response = await this.httpClient.request({
                method: "REPORT",
                url: calendarUrl,
                data: requestBody,
                headers: {
                    Depth: "1",
                },
                validateStatus: (status) => status >= 200 && status < 300,
            });
            return await parseFn(response.data);
        }
        catch (error) {
            throw new Error(`Failed to retrieve ${component.toLowerCase()}s from the CalDAV server.` +
                error);
        }
    }
    buildICSData(event, uid) {
        const vcalendar = new ical_js_1.default.Component(["vcalendar", [], []]);
        vcalendar.addPropertyWithValue("version", "2.0");
        vcalendar.addPropertyWithValue("method", "REQUEST");
        vcalendar.addPropertyWithValue("prodid", this.prodId);
        const vevent = new ical_js_1.default.Component("vevent");
        const e = new ical_js_1.default.Event(vevent);
        e.uid = uid;
        vevent.addPropertyWithValue("dtstamp", ical_js_1.default.Time.fromJSDate(new Date(), true));
        if (event.wholeDay) {
            e.startDate = ical_js_1.default.Time.fromDateString(event.start.toISOString().split("T")[0]);
            e.endDate = ical_js_1.default.Time.fromDateString(event.end.toISOString().split("T")[0]);
        }
        else {
            const start = ical_js_1.default.Time.fromJSDate(event.start, true);
            const end = ical_js_1.default.Time.fromJSDate(event.end, true);
            if (event.startTzid) {
                const prop = vevent.addPropertyWithValue("dtstart", start);
                prop.setParameter("tzid", event.startTzid);
            }
            else {
                e.startDate = start;
            }
            if (event.endTzid) {
                const prop = vevent.addPropertyWithValue("dtend", end);
                prop.setParameter("tzid", event.endTzid);
            }
            else {
                e.endDate = end;
            }
        }
        e.summary = event.summary;
        e.description = event.description || "";
        e.location = event.location || "";
        if (event.recurrenceRule) {
            const rruleProps = {};
            if (event.recurrenceRule.freq)
                rruleProps.FREQ = event.recurrenceRule.freq;
            if (event.recurrenceRule.interval)
                rruleProps.INTERVAL = event.recurrenceRule.interval;
            if (event.recurrenceRule.count)
                rruleProps.COUNT = event.recurrenceRule.count;
            if (event.recurrenceRule.until) {
                rruleProps.UNTIL = ical_js_1.default.Time.fromJSDate(event.recurrenceRule.until, true).toString();
            }
            if (event.recurrenceRule.byday)
                rruleProps.BYDAY = event.recurrenceRule.byday.join(",");
            if (event.recurrenceRule.bymonthday)
                rruleProps.BYMONTHDAY = event.recurrenceRule.bymonthday.join(",");
            if (event.recurrenceRule.bymonth)
                rruleProps.BYMONTH = event.recurrenceRule.bymonth.join(",");
            vevent.addPropertyWithValue("rrule", rruleProps);
        }
        if (event.alarms) {
            for (const alarm of event.alarms) {
                const valarm = new ical_js_1.default.Component("valarm");
                valarm.addPropertyWithValue("trigger", alarm.trigger);
                valarm.addPropertyWithValue("action", alarm.action);
                if (alarm.action === "DISPLAY" && alarm.description) {
                    valarm.addPropertyWithValue("description", alarm.description);
                }
                if (alarm.action === "EMAIL") {
                    if (alarm.summary)
                        valarm.addPropertyWithValue("summary", alarm.summary);
                    if (alarm.description)
                        valarm.addPropertyWithValue("description", alarm.description);
                    for (const attendee of alarm.attendees) {
                        valarm.addPropertyWithValue("attendee", attendee);
                    }
                }
                vevent.addSubcomponent(valarm);
            }
        }
        vcalendar.addSubcomponent(vevent);
        return vcalendar.toString();
    }
    buildTodoICSData(todo, uid) {
        const vcalendar = new ical_js_1.default.Component(["vcalendar", [], []]);
        vcalendar.addPropertyWithValue("version", "2.0");
        vcalendar.addPropertyWithValue("prodid", this.prodId);
        const vtodo = new ical_js_1.default.Component("vtodo");
        vtodo.addPropertyWithValue("uid", uid);
        vtodo.addPropertyWithValue("dtstamp", ical_js_1.default.Time.fromJSDate(new Date(), true));
        if (todo.start) {
            const start = ical_js_1.default.Time.fromJSDate(todo.start, true);
            vtodo.addPropertyWithValue("dtstart", start);
        }
        if (todo.due) {
            const due = ical_js_1.default.Time.fromJSDate(todo.due, true);
            vtodo.addPropertyWithValue("due", due);
        }
        if (todo.completed) {
            const comp = ical_js_1.default.Time.fromJSDate(todo.completed, true);
            vtodo.addPropertyWithValue("completed", comp);
        }
        vtodo.addPropertyWithValue("summary", todo.summary);
        if (todo.description) {
            vtodo.addPropertyWithValue("description", todo.description);
        }
        if (todo.location) {
            vtodo.addPropertyWithValue("location", todo.location);
        }
        if (todo.status) {
            vtodo.addPropertyWithValue("status", todo.status);
        }
        if (todo.sortOrder !== undefined) {
            vtodo.addPropertyWithValue("X-APPLE-SORT-ORDER", todo.sortOrder);
        }
        if (todo.alarms) {
            for (const alarm of todo.alarms) {
                const valarm = new ical_js_1.default.Component("valarm");
                valarm.addPropertyWithValue("trigger", alarm.trigger);
                valarm.addPropertyWithValue("action", alarm.action);
                if (alarm.action === "DISPLAY" && alarm.description) {
                    valarm.addPropertyWithValue("description", alarm.description);
                }
                if (alarm.action === "EMAIL") {
                    if (alarm.summary)
                        valarm.addPropertyWithValue("summary", alarm.summary);
                    if (alarm.description)
                        valarm.addPropertyWithValue("description", alarm.description);
                    for (const attendee of alarm.attendees) {
                        valarm.addPropertyWithValue("attendee", attendee);
                    }
                }
                vtodo.addSubcomponent(valarm);
            }
        }
        vcalendar.addSubcomponent(vtodo);
        return vcalendar.toString();
    }
    /**
     * Fetches the current ETag for a given event href.
     * Useful when the server does not return an ETag on creation (e.g. Yahoo).
     * @param href - The full CalDAV event URL (ending in .ics).
     * @returns The ETag string, or throws an error if not found.
     */
    async getETag(href) {
        var _a, _b, _c, _d, _e, _f, _g, _h, _j;
        try {
            const response = await this.httpClient.request({
                method: "PROPFIND",
                url: href,
                headers: {
                    Depth: "0",
                },
                data: `
        <d:propfind xmlns:d="DAV:">
          <d:prop><d:getetag/></d:prop>
        </d:propfind>
      `,
                validateStatus: (status) => status >= 200 && status < 300,
            });
            const parser = new fast_xml_parser_1.XMLParser({ removeNSPrefix: true });
            const parsed = parser.parse(response.data);
            const etag = ((_d = (_c = (_b = (_a = parsed === null || parsed === void 0 ? void 0 : parsed.multistatus) === null || _a === void 0 ? void 0 : _a.response) === null || _b === void 0 ? void 0 : _b.propstat) === null || _c === void 0 ? void 0 : _c.prop) === null || _d === void 0 ? void 0 : _d.getetag) ||
                ((_j = (_h = (_g = (_f = (_e = parsed === null || parsed === void 0 ? void 0 : parsed.multistatus) === null || _e === void 0 ? void 0 : _e.response) === null || _f === void 0 ? void 0 : _f[0]) === null || _g === void 0 ? void 0 : _g.propstat) === null || _h === void 0 ? void 0 : _h.prop) === null || _j === void 0 ? void 0 : _j.getetag);
            if (!etag) {
                throw new Error("ETag not found in PROPFIND response.");
            }
            return etag.replace(/^W\//, ""); // remove weak validator prefix if present
        }
        catch (error) {
            throw new Error(`Failed to retrieve ETag for ${href}: ${error}`);
        }
    }
    async createItem(calendarUrl, data, buildFn, itemType) {
        var _a;
        if (!calendarUrl) {
            throw new Error(`Calendar URL is required to create a ${itemType}.`);
        }
        const uid = data.uid || (0, uuid_1.v4)();
        if (calendarUrl.endsWith("/")) {
            calendarUrl = calendarUrl.slice(0, -1);
        }
        const href = `${calendarUrl}/${uid}.ics`;
        const ics = buildFn(data, uid);
        try {
            const response = await this.httpClient.put(href, ics, {
                headers: {
                    "Content-Type": "text/calendar; charset=utf-8",
                    "If-None-Match": "*",
                },
                validateStatus: (status) => status === 201 || status === 204,
            });
            const etag = response.headers["etag"] || "";
            const newCtag = await this.getCtag(calendarUrl);
            return {
                uid,
                href: `${calendarUrl.endsWith("/") ? calendarUrl : calendarUrl + "/"}${uid}.ics`,
                etag,
                newCtag,
            };
        }
        catch (error) {
            if (axios_1.default.isAxiosError(error) && ((_a = error.response) === null || _a === void 0 ? void 0 : _a.status) === 412) {
                throw new Error(`${itemType[0].toUpperCase() + itemType.slice(1)} with the specified uid already exists.`);
            }
            throw new Error(`Failed to create ${itemType}: ${error}`);
        }
    }
    isWeak(etag) {
        return (etag === null || etag === void 0 ? void 0 : etag.startsWith('W/"')) || (etag === null || etag === void 0 ? void 0 : etag.startsWith("W/"));
    }
    async updateItem(calendarUrl, item, buildFn, itemType) {
        var _a, _b;
        if (!item.uid || !item.href) {
            throw new Error(`Both 'uid' and 'href' are required to update a ${itemType}.`);
        }
        const normalizedUrl = calendarUrl.endsWith("/")
            ? calendarUrl.slice(0, -1)
            : calendarUrl;
        const ics = buildFn(item, item.uid);
        const ifMatch = (_a = item.etag) === null || _a === void 0 ? void 0 : _a.replace(/^W\//, "").trim();
        const ifMatchValue = this.isWeak(ifMatch) ? undefined : ifMatch;
        try {
            const response = await this.httpClient.put(item.href, ics, {
                headers: {
                    "Content-Type": "text/calendar; charset=utf-8",
                    ...(ifMatchValue ? { "If-Match": ifMatchValue } : {}),
                },
                validateStatus: (status) => status >= 200 && status < 300,
            });
            const newEtag = response.headers["etag"] || "";
            const newCtag = await this.getCtag(normalizedUrl);
            return {
                uid: item.uid,
                href: item.href,
                etag: newEtag,
                newCtag,
            };
        }
        catch (error) {
            if (axios_1.default.isAxiosError(error) && ((_b = error.response) === null || _b === void 0 ? void 0 : _b.status) === 412) {
                throw new Error(`${itemType[0].toUpperCase() + itemType.slice(1)} with the specified uid does not match.`);
            }
            throw new Error(`Failed to update ${itemType}: ${error}`);
        }
    }
    async deleteItem(calendarUrl, uid, itemType, etag) {
        const normalizedUrl = calendarUrl.endsWith("/")
            ? calendarUrl.slice(0, -1)
            : calendarUrl;
        const href = `${normalizedUrl}/${uid}.ics`;
        try {
            await this.httpClient.delete(href, {
                headers: {
                    "If-Match": etag !== null && etag !== void 0 ? etag : "*",
                },
                validateStatus: (status) => status === 204,
            });
        }
        catch (error) {
            throw new Error(`Failed to delete ${itemType}: ${error}`);
        }
    }
    /**
     * Creates a new event in the specified calendar.
     * @param calendarUrl - The URL of the calendar to create the event in.
     * @param eventData - The data for the event to create.
     * @returns The created event's metadata.
     */
    async createEvent(calendarUrl, eventData) {
        return this.createItem(calendarUrl, eventData, this.buildICSData.bind(this), "event");
    }
    /**
     * Creates a new todo in the specified calendar.
     * @param calendarUrl - The URL of the calendar to create the todo in.
     * @param todoData - The data for the todo to create.
     * @returns The created todo's metadata.
     */
    async createTodo(calendarUrl, todoData) {
        return this.createItem(calendarUrl, todoData, this.buildTodoICSData.bind(this), "todo");
    }
    /**
     * Updates an existing event in the specified calendar.
     * @param calendarUrl - The URL of the calendar to update the event in.
     * @param event - The event data to update.
     * @returns The updated event's metadata.
     */
    async updateEvent(calendarUrl, event) {
        return this.updateItem(calendarUrl, event, this.buildICSData.bind(this), "event");
    }
    /**
     * Updates an existing todo in the specified calendar.
     * @param calendarUrl - The URL of the calendar to update the todo in.
     * @param todo - The todo data to update.
     * @returns The updated todo's metadata.
     */
    async updateTodo(calendarUrl, todo) {
        return this.updateItem(calendarUrl, todo, this.buildTodoICSData.bind(this), "todo");
    }
    /**
     * Deletes an event from the specified calendar.
     * @param calendarUrl - The URL of the calendar to delete the event from.
     * @param eventUid - The UID of the event to delete.
     * @param etag - Optional ETag for conditional deletion.
     */
    async deleteEvent(calendarUrl, eventUid, etag) {
        return this.deleteItem(calendarUrl, eventUid, "event", etag);
    }
    /**
     * Deletes a todo from the specified calendar.
     * @param calendarUrl - The URL of the calendar to delete the todo from.
     * @param todoUid - The UID of the todo to delete.
     * @param etag - Optional ETag for conditional deletion.
     */
    async deleteTodo(calendarUrl, todoUid, etag) {
        return this.deleteItem(calendarUrl, todoUid, "todo", etag);
    }
    /**
     * Fetches the current CTag for a calendar.
     * @param calendarUrl - The URL of the calendar to fetch the CTag from.
     * @returns The CTag string.
     */
    async getCtag(calendarUrl) {
        const requestBody = `
      <d:propfind xmlns:d="DAV:" xmlns:cs="http://calendarserver.org/ns/">
        <d:prop>
          <cs:getctag />
        </d:prop>
      </d:propfind>`;
        const response = await this.httpClient.request({
            method: "PROPFIND",
            url: calendarUrl,
            data: requestBody,
            headers: {
                Depth: "0",
            },
            validateStatus: (status) => status === 207,
        });
        const parser = new fast_xml_parser_1.XMLParser({ removeNSPrefix: true });
        const jsonData = parser.parse(response.data);
        return jsonData["multistatus"]["response"]["propstat"]["prop"]["getctag"];
    }
    async getItemRefs(calendarUrl, component) {
        var _a, _b, _c;
        const requestBody = `
      <c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
        <d:prop>
            <d:getetag />
        </d:prop>
        <c:filter>
            <c:comp-filter name="VCALENDAR">
                <c:comp-filter name="${component}" />
            </c:comp-filter>
        </c:filter>
    </c:calendar-query>`;
        const response = await this.httpClient.request({
            method: "REPORT",
            url: calendarUrl,
            data: requestBody,
            headers: {
                Depth: "1",
            },
            validateStatus: (status) => status >= 200 && status < 300,
        });
        const parser = new fast_xml_parser_1.XMLParser({ removeNSPrefix: true });
        const jsonData = parser.parse(response.data);
        const refs = [];
        const rawResponses = (_a = jsonData === null || jsonData === void 0 ? void 0 : jsonData.multistatus) === null || _a === void 0 ? void 0 : _a.response;
        if (!rawResponses) {
            return [];
        }
        const responses = Array.isArray(rawResponses)
            ? rawResponses
            : [rawResponses];
        for (const obj of responses) {
            if (!obj || typeof obj !== "object")
                continue;
            const resultHref = obj["href"];
            const resultEtag = (_c = (_b = obj === null || obj === void 0 ? void 0 : obj.propstat) === null || _b === void 0 ? void 0 : _b.prop) === null || _c === void 0 ? void 0 : _c.getetag;
            if (resultHref && resultEtag) {
                refs.push({
                    href: resultHref,
                    etag: resultEtag,
                });
            }
        }
        return refs;
    }
    /**
     * Fetches events from a specific calendar by their hrefs.
     * @param calendarUrl - The URL of the calendar to fetch events from.
     * @param hrefs - The hrefs of the events to fetch.
     * @returns An array of Event objects.
     */
    async getEventsByHref(calendarUrl, hrefs) {
        return this.getItemsByHref(calendarUrl, hrefs, parser_1.parseEvents);
    }
    /**
     * Fetches todos from a specific calendar by their hrefs.
     * @param calendarUrl - The URL of the calendar to fetch todos from.
     * @param hrefs - The hrefs of the todos to fetch.
     * @returns An array of Todo objects.
     */
    async getTodosByHref(calendarUrl, hrefs) {
        return this.getItemsByHref(calendarUrl, hrefs, parser_1.parseTodos);
    }
    async getItemsByHref(calendarUrl, hrefs, parseFn) {
        if (!hrefs.length) {
            return [];
        }
        const filteredHrefs = hrefs.filter((href) => href.endsWith(".ics"));
        if (filteredHrefs.length === 0) {
            return [];
        }
        const requestBody = `
      <c:calendar-multiget xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
        <d:prop>
            <d:getetag />
            <c:calendar-data />
        </d:prop>
        ${filteredHrefs.map((href) => `<d:href>${href}</d:href>`).join("")}
      </c:calendar-multiget>`;
        const response = await this.httpClient.request({
            method: "REPORT",
            url: calendarUrl,
            data: requestBody,
            headers: {
                Depth: "1",
            },
            validateStatus: (status) => status >= 200 && status < 300,
        });
        return await parseFn(response.data);
    }
    diffRefs(remoteRefs, localRefs) {
        const localMap = new Map(localRefs.map((i) => [i.href, i.etag]));
        const remoteMap = new Map(remoteRefs.map((i) => [i.href, i.etag]));
        const newItems = [];
        const updatedItems = [];
        const deletedItems = [];
        for (const { href, etag } of remoteRefs) {
            if (!localMap.has(href)) {
                newItems.push(href);
            }
            else if (localMap.get(href) !== etag) {
                updatedItems.push(href);
            }
        }
        for (const { href } of localRefs) {
            if (!remoteMap.has(href)) {
                deletedItems.push(href);
            }
        }
        return { newItems, updatedItems, deletedItems };
    }
    /**
     * Synchronizes changes between local events and remote calendar.
     * @param calendarUrl - The URL of the calendar to sync with.
     * @param ctag - The current CTag of the calendar.
     * @param localEvents - The local events to compare against remote.
     * @returns An object containing the sync results.
     */
    async syncChanges(calendarUrl, ctag, localEvents) {
        const remoteCtag = await this.getCtag(calendarUrl);
        if (!ctag || ctag === remoteCtag) {
            return {
                changed: false,
                newCtag: remoteCtag,
                newEvents: [],
                updatedEvents: [],
                deletedEvents: [],
            };
        }
        const remoteRefs = await this.getItemRefs(calendarUrl, "VEVENT");
        const { newItems, updatedItems, deletedItems } = this.diffRefs(remoteRefs, localEvents);
        return {
            changed: true,
            newCtag: remoteCtag,
            newEvents: newItems,
            updatedEvents: updatedItems,
            deletedEvents: deletedItems,
        };
    }
    /**
     * Synchronizes changes between local todos and remote calendar.
     * @param calendarUrl - The URL of the calendar to sync with.
     * @param ctag - The current CTag of the calendar.
     * @param localTodos - The local todos to compare against remote.
     * @returns An object containing the sync results.
     */
    async syncTodoChanges(calendarUrl, ctag, localTodos) {
        const remoteCtag = await this.getCtag(calendarUrl);
        if (!ctag || ctag === remoteCtag) {
            return {
                changed: false,
                newCtag: remoteCtag,
                newTodos: [],
                updatedTodos: [],
                deletedTodos: [],
            };
        }
        const remoteRefs = await this.getItemRefs(calendarUrl, "VTODO");
        const { newItems, updatedItems, deletedItems } = this.diffRefs(remoteRefs, localTodos);
        return {
            changed: true,
            newCtag: remoteCtag,
            newTodos: newItems,
            updatedTodos: updatedItems,
            deletedTodos: deletedItems,
        };
    }
}
exports.CalDAVClient = CalDAVClient;
//# sourceMappingURL=client.js.map