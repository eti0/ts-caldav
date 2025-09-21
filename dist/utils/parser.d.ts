import { Calendar, Event, Todo } from "../models";
export declare const parseCalendars: (responseData: string, baseUrl?: string) => Promise<Calendar[]>;
export declare const parseEvents: (responseData: string, baseUrl?: string) => Promise<Event[]>;
export declare const parseTodos: (responseData: string, baseUrl?: string) => Promise<Todo[]>;
