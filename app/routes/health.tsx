import prisma from "../db.server";

export async function loader() {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return Response.json({ ok: true, service: "byndcart", database: "up" });
  } catch {
    return Response.json({ ok: false, service: "byndcart", database: "down" }, { status: 503 });
  }
}
