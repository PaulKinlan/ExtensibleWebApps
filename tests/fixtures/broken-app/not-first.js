// Its manifest isn't the module's first statement.
const name = "Late";
export const manifest = { id: "not-first", name, permissions: [] };
export default function () {}
