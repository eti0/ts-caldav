import { CalDAVClient } from "../src/client";
import dotenv from "dotenv";

dotenv.config();

const getDateRange = () => ({
  start: new Date(Date.now() - 24 * 60 * 60 * 1000),
  end: new Date(Date.now() + 24 * 60 * 60 * 1000),
});

describe("Recurring Event Handling", () => {
  let client: CalDAVClient;
  let calendarUrl: string;

  beforeAll(async () => {
    client = await CalDAVClient.create({
      baseUrl: process.env.CALDAV_BASE_URL!,
      auth: {
        type: "basic",
        username: process.env.CALDAV_USERNAME!,
        password: process.env.CALDAV_PASSWORD!,
      },
      requestTimeout: 30000,
    });

    const calendars = await client.getCalendars();
    calendarUrl = calendars[0].url;
  });
  let recurringUid: string;

  test("Create recurring weekly event", async () => {
    const now = new Date();
    const end = new Date(now.getTime() + 3600000);

    const res = await client.createEvent(calendarUrl, {
      start: now,
      end,
      summary: "Weekly Recurrence",
      recurrenceRule: {
        freq: "WEEKLY",
        interval: 1,
        count: 5,
      },
    });

    recurringUid = res.uid;
    expect(recurringUid).toBeDefined();
  });

  test("Verify recurrence data", async () => {
    const events = await client.getEvents(calendarUrl, {
      start: new Date(Date.now() - 7 * 86400000),
      end: new Date(Date.now() + 30 * 86400000),
    });

    const recurring = events.find((e) => e.uid === recurringUid);
    expect(recurring?.recurrenceRule?.freq).toBe("WEEKLY");
    expect(recurring?.recurrenceRule?.count).toBe(5);
  });

  test("Delete recurring weekly event", async () => {
    await client.deleteEvent(calendarUrl, recurringUid);
  });

  test("Create recurring by day event", async () => {
    const now = new Date();
    const end = new Date(now.getTime() + 3600000);

    const res = await client.createEvent(calendarUrl, {
      start: now,
      end,
      summary: "Weekdays",
      recurrenceRule: {
        freq: "DAILY",
        interval: 1,
        count: 10,
        byday: ["MO", "TU", "WE", "TH", "FR"],
      },
    });

    recurringUid = res.uid;
    expect(recurringUid).toBeDefined();
  });

  test("Validate daily byday recurrence", async () => {
    const events = await client.getEvents(calendarUrl, getDateRange());
    const evt = events.find((e) => e.uid === recurringUid);

    expect(evt?.recurrenceRule?.freq).toBe("DAILY");
    expect(evt?.recurrenceRule?.byday).toEqual(["MO", "TU", "WE", "TH", "FR"]);
  });

  test("Clean up daily byday recurrence", async () => {
    await client.deleteEvent(calendarUrl, recurringUid);
  });
});
