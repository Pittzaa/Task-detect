import { z } from "zod";

/** Control, bidi and line-separator characters have no place in a name that is shown in lists and put into e-mails and chat messages. */
export const NAME_FORBIDDEN = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f\\u200e\\u200f\\u2028-\\u202e\\u2066-\\u2069]");
export const displayNameSchema = z.string().trim().min(1).max(100).refine((v) => !NAME_FORBIDDEN.test(v), "invalid characters");
export const imageSchema = z.string().max(2048);
