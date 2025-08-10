import { CalDAVClient } from "../src/client";
import dotenv from "dotenv";

dotenv.config();

const getDateRange = () => ({
  start: new Date(Date.now() - 24 * 60 * 60 * 1000),
  end: new Date(Date.now() + 24 * 60 * 60 * 1000),
});

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
  calendarUrl =
    calendars.find((cal) => cal.supportedComponents.includes("VTODO"))?.url ||
    calendars[0].url;
});

describe("CalDAVClient Todo Operations", () => {
  let todoUid: string;
  let todoHrefs: string[] = [];
  let changeTag: string = "";

  test("Create and fetch todo", async () => {
    const now = new Date();
    const end = new Date(now.getTime());

    const created = await client.createTodo(calendarUrl, {
      due: end,
      summary: "Test Todo",
    });
    todoUid = created.uid;
    const todos = await client.getTodos(calendarUrl, getDateRange());
    const found = todos.find((e) => e.uid === todoUid);

    expect(found).toBeDefined();
    expect(found?.summary).toBe("Test Todo");
  });

  test("Duplicate todo creation fails", async () => {
    const now = new Date();
    const end = new Date(now.getTime() + 3600000);

    await expect(
      client.createTodo(calendarUrl, {
        due: end,
        summary: "Duplicate",
        uid: todoUid,
      })
    ).rejects.toThrow("already exists");
  });

  test("Delete created todo", async () => {
    await client.deleteTodo(calendarUrl, todoUid);
  });

  test("Sync todos and get by href", async () => {
    const now = new Date();
    const end = new Date(now.getTime() + 3600000);
    changeTag = await client.getCtag(calendarUrl);

    const res = await client.createTodo(calendarUrl, {
      due: end,
      summary: "Sync Test Todo",
    });

    todoUid = res.uid;

    const sync = await client.syncTodoChanges(calendarUrl, changeTag, []);
    todoHrefs = [...sync.newTodos, ...sync.updatedTodos];

    const fetched = await client.getTodosByHref(calendarUrl, todoHrefs);
    expect(fetched.length).toBeGreaterThan(0);
  });

  test("Clean up sync todo", async () => {
    await client.deleteTodo(calendarUrl, todoUid);
  });

  test("Fetch ETag using getETag", async () => {
    const now = new Date();
    const end = new Date(now.getTime() + 3600000);

    const { uid, href } = await client.createTodo(calendarUrl, {
      due: end,
      summary: "ETag Fetch Test",
    });

    const etag = await client.getETag(href);

    expect(typeof etag).toBe("string");
    expect(etag.length).toBeGreaterThan(0);

    await client.deleteTodo(calendarUrl, uid);
  });

  test("Update todo", async () => {
    const createRes = await client.createTodo(calendarUrl, {
      due: new Date(),
      summary: "Original Title",
    });

    const etag = await client.getETag(createRes.href);

    const updated = await client.updateTodo(calendarUrl, {
      uid: createRes.uid,
      href: createRes.href,
      etag,
      due: new Date(),
      summary: "Updated Title",
    });

    const todos = await client.getTodosByHref(calendarUrl, [updated.href]);
    const updatedTodo = todos.find((e) => e.href === updated.href);

    expect(updatedTodo).toBeDefined();
    expect(updatedTodo?.summary).toBe("Updated Title");

    await client.deleteTodo(calendarUrl, updated.uid);
  });

  test("Update todo 2x", async () => {
    const createRes = await client.createTodo(calendarUrl, {
      due: new Date(),
      summary: "Original Title",
    });

    const etag = await client.getETag(createRes.href);

    const updated = await client.updateTodo(calendarUrl, {
      uid: createRes.uid,
      href: createRes.href,
      etag,
      due: new Date(),
      summary: "Updated Title",
    });

    // wait a bit to ensure the ETag changes
    await new Promise((resolve) => setTimeout(resolve, 2000));

    const newUpdated = await client.updateTodo(calendarUrl, {
      uid: createRes.uid,
      href: createRes.href,
      etag: updated.etag,
      due: new Date(),
      summary: "Updated Title",
    });

    const todos = await client.getTodosByHref(calendarUrl, [newUpdated.href]);
    const updatedTodo = todos.find((e) => e.href === newUpdated.href);

    expect(updatedTodo).toBeDefined();
    expect(updatedTodo?.summary).toBe("Updated Title");

    await client.deleteTodo(calendarUrl, newUpdated.uid);
  });

  test("Sort order in todo", async () => {
    const now = new Date();
    const end = new Date(now.getTime() + 3600000);

    const res = await client.createTodo(calendarUrl, {
      due: end,
      summary: "Sort Order Test",
      sortOrder: 100,
    });

    const todos = await client.getTodos(calendarUrl, getDateRange());
    const created = todos.find((e) => e.uid === res.uid);

    expect(created).toBeDefined();
    expect(created?.sortOrder).toBe(100);

    await client.deleteTodo(calendarUrl, res.uid);
  });
});
