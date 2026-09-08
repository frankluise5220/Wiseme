import type { Prisma } from "@prisma/client";

export function categoryOrderBy(): Prisma.CategoryOrderByWithRelationInput[] {
  return [
    { type: "asc" },
    { parentId: "asc" },
    { isSystem: "asc" },
    { sortOrder: "asc" },
    { name: "asc" },
    { id: "asc" },
  ];
}
