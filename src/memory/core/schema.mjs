export const text = { type: "string" };
export const strings = { type: "array", items: text };
export const choice = (...values) => ({ type: "string", enum: values });
export const object = (properties) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
export const records = (properties) => ({
  type: "array",
  items: object(properties),
});

export function validateSchema(value, schema, path = "proposal") {
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error(`${path} must be an object`);
    for (const key of Object.keys(value))
      if (!Object.hasOwn(schema.properties, key))
        throw new Error(`${path}.${key} is unknown`);
    for (const key of schema.required) {
      if (!Object.hasOwn(value, key))
        throw new Error(`${path}.${key} is required`);
      validateSchema(value[key], schema.properties[key], `${path}.${key}`);
    }
    return;
  }
  if (schema.type === "array") {
    if (!Array.isArray(value) || value.length > 200)
      throw new Error(`${path} must be a bounded array`);
    value.forEach((item, index) => {
      validateSchema(item, schema.items, `${path}[${index}]`);
    });
    return;
  }
  if (typeof value !== "string" || value.length > 20_000)
    throw new Error(`${path} must be a bounded string`);
  if (schema.enum && !schema.enum.includes(value))
    throw new Error(`${path} is not an allowed value`);
}
