import axios, { AxiosInstance } from "axios";
import { encode } from "base-64";
import { XMLParser } from "fast-xml-parser";
import ICAL from "ical.js";
import { v4 as uuidv4 } from "uuid";
import {
	CalDAVClientCache,
	CalDAVOptions,
	Calendar,
	Event,
	EventRef,
	SyncChangesResult,
	SyncTodosResult,
	Todo,
	TodoRef,
} from "./models";
import { formatDate } from "./utils/encode";
import { parseCalendars, parseEvents, parseTodos } from "./utils/parser";

type Omit<T, K extends keyof T> = Pick<T, Exclude<keyof T, K>>;
type PartialBy<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>;

export class CalDAVClient {
	private httpClient: AxiosInstance;
	private prodId: string;
	public calendarHome: string | null;
	public userPrincipal: string | null;
	public requestTimeout: number;
	public baseUrl: string;

	private resolveUrl(path: string): string {
		const basePath = new URL(this.baseUrl).pathname;
		if (path.startsWith(basePath) && basePath !== "/") {
			const stripped = path.substring(basePath.length);
			return stripped.startsWith("/") ? stripped : "/" + stripped;
		}
		return path;
	}

	private constructor(private options: CalDAVOptions) {
		this.httpClient = axios.create({
			baseURL: options.baseUrl,
			headers: {
				Authorization:
					options.auth.type === "basic"
						? `Basic ${encode(
								`${options.auth.username}:${options.auth.password}`,
							)}`
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
	static async create(options: CalDAVOptions): Promise<CalDAVClient> {
		const client = new CalDAVClient(options);
		const isGoogle =
			options.baseUrl?.includes("apidata.googleusercontent.com") ?? false;
		const discoveryPath = isGoogle ? `/caldav/v2/` : "/";
		await client.validateCredentials(discoveryPath);
		await client.fetchCalendarHome();
		return client;
	}

	private async validateCredentials(discoveryPath: string): Promise<void> {
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
				throw new Error(
					"User principal not found: Unable to authenticate with the server.",
				);
			}
			const parser = new XMLParser({
				removeNSPrefix: true,
			});
			const jsonData = parser.parse(response.data, {});

			const userPrincipalPath =
				jsonData["multistatus"]["response"]["propstat"]["prop"][
					"current-user-principal"
				]["href"];

			this.userPrincipal = this.resolveUrl(userPrincipalPath);
		} catch (error) {
			throw new Error(
				"Invalid credentials: Unable to authenticate with the server." + error,
			);
		}
	}

	private async fetchCalendarHome(): Promise<string | null> {
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

		const parser = new XMLParser({ removeNSPrefix: true });
		const jsonData = parser.parse(response.data);

		const calendarHomePath =
			jsonData["multistatus"]["response"]["propstat"]["prop"][
				"calendar-home-set"
			]["href"];

		this.calendarHome = this.resolveUrl(calendarHomePath);
		return this.calendarHome;
	}

	public getCalendarHome(): string | null {
		return this.calendarHome;
	}

	/**
	 * Exports the current client state to a cache object.
	 * This can be used to restore the client state later without re-fetching the calendar home.
	 * @returns A CalDAVClientCache object containing the current client state.
	 */
	public exportCache(): CalDAVClientCache {
		return {
			userPrincipal: this.userPrincipal!,
			calendarHome: this.calendarHome!,
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
	static async createFromCache(
		options: CalDAVOptions,
		cache: CalDAVClientCache,
	): Promise<CalDAVClient> {
		const client = new CalDAVClient(options);
		client.userPrincipal = client.resolveUrl(cache.userPrincipal);
		client.calendarHome = client.resolveUrl(cache.calendarHome);
		if (cache.prodId) client.prodId = cache.prodId;
		return client; // no validateCredentials / no fetchCalendarHome
	}

	/**
	 * Fetches all calendars available to the authenticated user.
	 * @returns An array of Calendar objects.
	 * @throws An error if the calendar home is not found or if the request fails.
	 */
	public async getCalendars(): Promise<Calendar[]> {
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

		const calendars = await parseCalendars(response.data);
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
	public async getEvents(
		calendarUrl: string,
		options?: { start?: Date; end?: Date; all?: boolean },
	): Promise<Event[]> {
		return this.getComponents<Event>(
			calendarUrl,
			"VEVENT",
			parseEvents,
			options,
		);
	}

	/**
	 * Fetches all todos from a specific calendar.
	 * @param calendarUrl - The URL of the calendar to fetch todos from.
	 * @param options - Optional parameters for fetching todos.
	 * @returns An array of Todo objects.
	 */
	public async getTodos(
		calendarUrl: string,
		options?: { start?: Date; end?: Date; all?: boolean },
	): Promise<Todo[]> {
		return this.getComponents<Todo>(calendarUrl, "VTODO", parseTodos, {
			all: true,
			...options,
		});
	}

	private async getComponents<T>(
		calendarUrl: string,
		component: "VEVENT" | "VTODO",
		parseFn: (xml: string) => Promise<T[]>,
		options?: { start?: Date; end?: Date; all?: boolean },
	): Promise<T[]> {
		const now = new Date();
		const defaultEnd = new Date(now.getTime() + 3 * 7 * 24 * 60 * 60 * 1000);
		const { start = now, end = defaultEnd, all } = options || {};

		const timeRangeFilter =
			start && end && !all
				? `<c:comp-filter name="${component}">
             <c:time-range start="${formatDate(start)}" end="${formatDate(
								end,
							)}" />
           </c:comp-filter>`
				: `<c:comp-filter name="${component}" />`;

		const calendarData =
			start && end && !all && component === "VEVENT"
				? ` <c:calendar-data>
            <c:expand start="${formatDate(start)}" end="${formatDate(end)}"/>
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
		} catch (error) {
			throw new Error(
				`Failed to retrieve ${component.toLowerCase()}s from the CalDAV server.` +
					error,
			);
		}
	}

	private buildICSData(
		event: PartialBy<Event, "uid" | "etag" | "href">,
		uid: string,
	): string {
		const vcalendar = new ICAL.Component(["vcalendar", [], []]);
		vcalendar.addPropertyWithValue("version", "2.0");
		vcalendar.addPropertyWithValue("method", "REQUEST");
		vcalendar.addPropertyWithValue("prodid", this.prodId);

		const vevent = new ICAL.Component("vevent");
		const e = new ICAL.Event(vevent);

		e.uid = uid;

		vevent.addPropertyWithValue(
			"dtstamp",
			ICAL.Time.fromJSDate(new Date(), true),
		);

		if (event.wholeDay) {
			e.startDate = ICAL.Time.fromDateString(
				event.start.toISOString().split("T")[0],
			);
			e.endDate = ICAL.Time.fromDateString(
				event.end.toISOString().split("T")[0],
			);
		} else {
			const start = ICAL.Time.fromJSDate(event.start, true);
			const end = ICAL.Time.fromJSDate(event.end, true);

			if (event.startTzid) {
				try {
					const tz = ICAL.TimezoneService.get(event.startTzid);
					if (tz) {
						const localStart = start.convertToZone(tz);
						const prop = vevent.addPropertyWithValue("dtstart", localStart);
						prop.setParameter("tzid", event.startTzid);
					} else {
						e.startDate = start;
					}
				} catch {
					e.startDate = start;
				}
			} else {
				e.startDate = start;
			}

			if (event.endTzid) {
				try {
					const tz = ICAL.TimezoneService.get(event.endTzid);
					if (tz) {
						const localEnd = end.convertToZone(tz);
						const prop = vevent.addPropertyWithValue("dtend", localEnd);
						prop.setParameter("tzid", event.endTzid);
					} else {
						e.endDate = end;
					}
				} catch {
					e.endDate = end;
				}
			} else {
				e.endDate = end;
			}
		}

		e.summary = event.summary;
		e.description = event.description || "";
		e.location = event.location || "";

		if (event.recurrenceRule) {
			const rruleProps: Record<string, string | number> = {};

			if (event.recurrenceRule.freq)
				rruleProps.FREQ = event.recurrenceRule.freq;
			if (event.recurrenceRule.interval)
				rruleProps.INTERVAL = event.recurrenceRule.interval;
			if (event.recurrenceRule.count)
				rruleProps.COUNT = event.recurrenceRule.count;
			if (event.recurrenceRule.until) {
				rruleProps.UNTIL = ICAL.Time.fromJSDate(
					event.recurrenceRule.until,
					true,
				).toString();
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
				const valarm = new ICAL.Component("valarm");

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

	private buildTodoICSData(
		todo: PartialBy<Todo, "uid" | "etag" | "href">,
		uid: string,
	): string {
		const vcalendar = new ICAL.Component(["vcalendar", [], []]);
		vcalendar.addPropertyWithValue("version", "2.0");
		vcalendar.addPropertyWithValue("prodid", this.prodId);

		const vtodo = new ICAL.Component("vtodo");

		vtodo.addPropertyWithValue("uid", uid);
		vtodo.addPropertyWithValue(
			"dtstamp",
			ICAL.Time.fromJSDate(new Date(), true),
		);

		if (todo.start) {
			const start = ICAL.Time.fromJSDate(todo.start, true);
			vtodo.addPropertyWithValue("dtstart", start);
		}

		if (todo.due) {
			const due = ICAL.Time.fromJSDate(todo.due, true);
			vtodo.addPropertyWithValue("due", due);
		}

		if (todo.completed) {
			const comp = ICAL.Time.fromJSDate(todo.completed, true);
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
				const valarm = new ICAL.Component("valarm");

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
	public async getETag(href: string): Promise<string> {
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

			const parser = new XMLParser({ removeNSPrefix: true });
			const parsed = parser.parse(response.data);

			const etag =
				parsed?.multistatus?.response?.propstat?.prop?.getetag ||
				parsed?.multistatus?.response?.[0]?.propstat?.prop?.getetag;

			if (!etag) {
				throw new Error("ETag not found in PROPFIND response.");
			}

			return etag.replace(/^W\//, ""); // remove weak validator prefix if present
		} catch (error) {
			throw new Error(`Failed to retrieve ETag for ${href}: ${error}`);
		}
	}

	private async createItem<
		T extends { uid?: string; href?: string; etag?: string },
	>(
		calendarUrl: string,
		data: PartialBy<T, "uid" | "href" | "etag">,
		buildFn: (
			data: PartialBy<T, "uid" | "href" | "etag">,
			uid: string,
		) => string,
		itemType: "event" | "todo",
	): Promise<{ uid: string; href: string; etag: string; newCtag: string }> {
		if (!calendarUrl) {
			throw new Error(`Calendar URL is required to create a ${itemType}.`);
		}
		const uid = data.uid || uuidv4();

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
				href: `${
					calendarUrl.endsWith("/") ? calendarUrl : calendarUrl + "/"
				}${uid}.ics`,
				etag,
				newCtag,
			};
		} catch (error) {
			if (axios.isAxiosError(error) && error.response?.status === 412) {
				throw new Error(
					`${
						itemType[0].toUpperCase() + itemType.slice(1)
					} with the specified uid already exists.`,
				);
			}
			throw new Error(`Failed to create ${itemType}: ${error}`);
		}
	}

	private isWeak(etag?: string) {
		return etag?.startsWith('W/"') || etag?.startsWith("W/");
	}

	private async updateItem<
		T extends { uid: string; href: string; etag?: string },
	>(
		calendarUrl: string,
		item: T,
		buildFn: (item: T, uid: string) => string,
		itemType: "event" | "todo",
	): Promise<{ uid: string; href: string; etag: string; newCtag: string }> {
		if (!item.uid || !item.href) {
			throw new Error(
				`Both 'uid' and 'href' are required to update a ${itemType}.`,
			);
		}

		const normalizedUrl = calendarUrl.endsWith("/")
			? calendarUrl.slice(0, -1)
			: calendarUrl;
		const ics = buildFn(item, item.uid);
		const ifMatch = item.etag?.replace(/^W\//, "").trim();
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
		} catch (error) {
			if (axios.isAxiosError(error) && error.response?.status === 412) {
				throw new Error(
					`${
						itemType[0].toUpperCase() + itemType.slice(1)
					} with the specified uid does not match.`,
				);
			}
			throw new Error(`Failed to update ${itemType}: ${error}`);
		}
	}

	private async deleteItem(
		calendarUrl: string,
		uid: string,
		itemType: "event" | "todo",
		etag?: string,
	): Promise<void> {
		const normalizedUrl = calendarUrl.endsWith("/")
			? calendarUrl.slice(0, -1)
			: calendarUrl;

		const href = `${normalizedUrl}/${uid}.ics`;

		try {
			await this.httpClient.delete(href, {
				headers: {
					"If-Match": etag ?? "*",
				},
				validateStatus: (status) => status === 204,
			});
		} catch (error) {
			throw new Error(`Failed to delete ${itemType}: ${error}`);
		}
	}

	/**
	 * Creates a new event in the specified calendar.
	 * @param calendarUrl - The URL of the calendar to create the event in.
	 * @param eventData - The data for the event to create.
	 * @returns The created event's metadata.
	 */
	public async createEvent(
		calendarUrl: string,
		eventData: PartialBy<Event, "uid" | "href" | "etag">,
	): Promise<{ uid: string; href: string; etag: string; newCtag: string }> {
		return this.createItem<Event>(
			calendarUrl,
			eventData,
			this.buildICSData.bind(this),
			"event",
		);
	}

	/**
	 * Creates a new todo in the specified calendar.
	 * @param calendarUrl - The URL of the calendar to create the todo in.
	 * @param todoData - The data for the todo to create.
	 * @returns The created todo's metadata.
	 */
	public async createTodo(
		calendarUrl: string,
		todoData: PartialBy<Todo, "uid" | "href" | "etag">,
	): Promise<{ uid: string; href: string; etag: string; newCtag: string }> {
		return this.createItem<Todo>(
			calendarUrl,
			todoData,
			this.buildTodoICSData.bind(this),
			"todo",
		);
	}

	/**
	 * Updates an existing event in the specified calendar.
	 * @param calendarUrl - The URL of the calendar to update the event in.
	 * @param event - The event data to update.
	 * @returns The updated event's metadata.
	 */
	public async updateEvent(
		calendarUrl: string,
		event: Event,
	): Promise<{ uid: string; href: string; etag: string; newCtag: string }> {
		return this.updateItem<Event>(
			calendarUrl,
			event,
			this.buildICSData.bind(this),
			"event",
		);
	}

	/**
	 * Updates an existing todo in the specified calendar.
	 * @param calendarUrl - The URL of the calendar to update the todo in.
	 * @param todo - The todo data to update.
	 * @returns The updated todo's metadata.
	 */
	public async updateTodo(
		calendarUrl: string,
		todo: Todo,
	): Promise<{ uid: string; href: string; etag: string; newCtag: string }> {
		return this.updateItem<Todo>(
			calendarUrl,
			todo,
			this.buildTodoICSData.bind(this),
			"todo",
		);
	}

	/**
	 * Deletes an event from the specified calendar.
	 * @param calendarUrl - The URL of the calendar to delete the event from.
	 * @param eventUid - The UID of the event to delete.
	 * @param etag - Optional ETag for conditional deletion.
	 */
	public async deleteEvent(
		calendarUrl: string,
		eventUid: string,
		etag?: string,
	): Promise<void> {
		return this.deleteItem(calendarUrl, eventUid, "event", etag);
	}

	/**
	 * Deletes a todo from the specified calendar.
	 * @param calendarUrl - The URL of the calendar to delete the todo from.
	 * @param todoUid - The UID of the todo to delete.
	 * @param etag - Optional ETag for conditional deletion.
	 */
	public async deleteTodo(
		calendarUrl: string,
		todoUid: string,
		etag?: string,
	): Promise<void> {
		return this.deleteItem(calendarUrl, todoUid, "todo", etag);
	}

	/**
	 * Fetches the current CTag for a calendar.
	 * @param calendarUrl - The URL of the calendar to fetch the CTag from.
	 * @returns The CTag string.
	 */
	public async getCtag(calendarUrl: string): Promise<string> {
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

		const parser = new XMLParser({ removeNSPrefix: true });
		const jsonData = parser.parse(response.data);
		return jsonData["multistatus"]["response"]["propstat"]["prop"]["getctag"];
	}

	private async getItemRefs(
		calendarUrl: string,
		component: "VEVENT" | "VTODO",
	): Promise<{ href: string; etag: string }[]> {
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

		const parser = new XMLParser({ removeNSPrefix: true });
		const jsonData = parser.parse(response.data);
		const refs: { href: string; etag: string }[] = [];
		const rawResponses = jsonData?.multistatus?.response;

		if (!rawResponses) {
			return [];
		}

		const responses = Array.isArray(rawResponses)
			? rawResponses
			: [rawResponses];

		for (const obj of responses) {
			if (!obj || typeof obj !== "object") continue;

			const resultHref = obj["href"];
			const resultEtag = obj?.propstat?.prop?.getetag;

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
	public async getEventsByHref(
		calendarUrl: string,
		hrefs: string[],
	): Promise<Event[]> {
		return this.getItemsByHref<Event>(calendarUrl, hrefs, parseEvents);
	}

	/**
	 * Fetches todos from a specific calendar by their hrefs.
	 * @param calendarUrl - The URL of the calendar to fetch todos from.
	 * @param hrefs - The hrefs of the todos to fetch.
	 * @returns An array of Todo objects.
	 */
	public async getTodosByHref(
		calendarUrl: string,
		hrefs: string[],
	): Promise<Todo[]> {
		return this.getItemsByHref<Todo>(calendarUrl, hrefs, parseTodos);
	}

	private async getItemsByHref<T>(
		calendarUrl: string,
		hrefs: string[],
		parseFn: (xml: string) => Promise<T[]>,
	): Promise<T[]> {
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

	private diffRefs(
		remoteRefs: { href: string; etag: string }[],
		localRefs: { href: string; etag: string }[],
	): {
		newItems: string[];
		updatedItems: string[];
		deletedItems: string[];
	} {
		const localMap = new Map(localRefs.map((i) => [i.href, i.etag]));
		const remoteMap = new Map(remoteRefs.map((i) => [i.href, i.etag]));

		const newItems: string[] = [];
		const updatedItems: string[] = [];
		const deletedItems: string[] = [];

		for (const { href, etag } of remoteRefs) {
			if (!localMap.has(href)) {
				newItems.push(href);
			} else if (localMap.get(href) !== etag) {
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
	public async syncChanges(
		calendarUrl: string,
		ctag: string,
		localEvents: EventRef[],
	): Promise<SyncChangesResult> {
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
		const { newItems, updatedItems, deletedItems } = this.diffRefs(
			remoteRefs,
			localEvents,
		);

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
	public async syncTodoChanges(
		calendarUrl: string,
		ctag: string,
		localTodos: TodoRef[],
	): Promise<SyncTodosResult> {
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
		const { newItems, updatedItems, deletedItems } = this.diffRefs(
			remoteRefs,
			localTodos,
		);

		return {
			changed: true,
			newCtag: remoteCtag,
			newTodos: newItems,
			updatedTodos: updatedItems,
			deletedTodos: deletedItems,
		};
	}
}
