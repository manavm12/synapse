export function databaseSsl(env = process.env) {
  if (env.DATABASE_SSL === "disable") return false;
  if (
    env.DATABASE_SSL &&
    !["require", "verify-full"].includes(env.DATABASE_SSL)
  ) {
    throw new Error("DATABASE_SSL must be disable, require, or verify-full");
  }
  const encodedCertificate = env.DATABASE_CA_CERT;
  const ca = encodedCertificate
    ? encodedCertificate.replaceAll("\\n", "\n")
    : undefined;
  return {
    rejectUnauthorized: true,
    ...(ca ? { ca } : {}),
  };
}
