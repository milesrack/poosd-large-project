import assert from "node:assert/strict";
import SwaggerParser from "@apidevtools/swagger-parser";
import { Ajv } from "ajv";
import addFormats from "ajv-formats";
import type { OpenAPIV3 } from "openapi-types";

export async function apiContract() {
  const document = (await SwaggerParser.validate(
    "openapi.yaml",
  )) as OpenAPIV3.Document;
  const ajv = new Ajv({ allErrors: true });
  addFormats.default(ajv);
  const validators = new Map<string, ReturnType<typeof ajv.compile>>();

  return {
    document,
    async response(path: string, response: Response) {
      const operation = document.paths[path]?.get;
      assert.ok(operation, `Undocumented GET ${path}`);

      const contract = operation.responses[
        String(response.status)
      ] as OpenAPIV3.ResponseObject;

      assert.ok(contract, `Undocumented GET ${path} status ${response.status}`);

      assert.match(
        response.headers.get("content-type") ?? "",
        /application\/json/,
      );

      const key = `${path}:${response.status}`;
      let validate = validators.get(key);

      if (!validate) {
        const schema = contract.content?.["application/json"]?.schema;
        assert.ok(schema, `Missing response schema for ${key}`);
        validate = ajv.compile(schema);
        validators.set(key, validate);
      }

      const body: unknown = await response.json();
      assert.ok(validate(body), `${key}: ${ajv.errorsText(validate.errors)}`);

      return body;
    },
  };
}

if (import.meta.main) {
  await apiContract();
  console.log("OpenAPI definition and response schemas validated");
}
