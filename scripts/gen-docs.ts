import { writeFileSync } from "node:fs";
import { rbacMatrixMarkdown } from "../src/authz/matrix";

// Regenerates the parts of the documentation that are derived from code. The ER diagram needs a database: pnpm docs:erd.
writeFileSync("docs/generated/rbac-matrix.md", rbacMatrixMarkdown());
console.log("wrote docs/generated/rbac-matrix.md");
