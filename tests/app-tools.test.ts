import { expect, it } from "vitest";
import { createAppCommand } from "../src/app-tools.js";

it("builds fixed Nx generator commands", () => {
  expect(createAppCommand("npm", { appName: "admin", framework: "next" })).toEqual({
    command: "npx",
    args: ["nx", "g", "@nx/next:app", "admin", "--no-interactive"],
  });

  expect(
    createAppCommand("pnpm", {
      appName: "ops-dashboard",
      framework: "react",
      directory: "apps",
      dryRun: true,
    }),
  ).toEqual({
    command: "pnpm",
    args: ["exec", "nx", "g", "@nx/react:app", "ops-dashboard", "--no-interactive", "--directory=apps", "--dry-run"],
  });
});
