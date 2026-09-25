import { z } from "zod";

export const historyLimit = z.coerce.number().int().min(1).max(200).default(50);
