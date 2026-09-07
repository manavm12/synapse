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

// node-postgres reparses connectionString after applying the supplied ssl
// object. URL SSL options can otherwise silently override verified TLS.
export function databaseConnectionOptions({
  connectionString,
  ssl,
  ...options
}) {
  let url;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error("Database connection must be a PostgreSQL URL");
  }
  if (!["postgres:", "postgresql:"].includes(url.protocol)) {
    throw new Error("Database connection must be a PostgreSQL URL");
  }
  for (const key of url.searchParams.keys()) {
    if (/^ssl/i.test(key) || key.toLowerCase() === "uselibpqcompat") {
      throw new Error(
        "Remove SSL options from the database URL; configure DATABASE_SSL and DATABASE_CA_CERT instead",
      );
    }
  }
  return { ...options, connectionString, ssl };
}
