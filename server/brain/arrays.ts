import { unzipSync, zipSync } from "fflate";

export type NumericArray =
  | Float32Array
  | Float64Array
  | Int8Array
  | Uint8Array
  | Int16Array
  | Uint16Array
  | Int32Array
  | Uint32Array;

export type NumericKind = "f" | "i" | "u" | "b";

export interface NumericDecodedArray {
  data: NumericArray;
  shape: number[];
  dtype: NumericKind;
  width: number;
}

export interface UnicodeDecodedArray {
  data: string;
  shape: number[];
  dtype: "U";
}

export type DecodedArray = NumericDecodedArray | UnicodeDecodedArray;

export type Archive = Record<string, DecodedArray>;

export interface ExportArray {
  data: number | ArrayLike<number> | string;
  shape?: number[];
  dtype?: string;
}

const setters = {
  "<i1": "setInt8",
  "<u1": "setUint8",
  "<i2": "setInt16",
  "<u2": "setUint16",
  "<i4": "setInt32",
  "<u4": "setUint32",
  "<f4": "setFloat32",
  "<f8": "setFloat64",
} as const;
const LIMIT = 64 * 1024 ** 2;
const decoder = new TextDecoder();

export function decodeArray(bytes: Uint8Array): DecodedArray {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  if (
    bytes.length < 10 ||
    bytes[0] !== 147 ||
    decoder.decode(bytes.subarray(1, 6)) !== "NUMPY"
  ) {
    throw Error("Invalid NPY signature");
  }

  const version = bytes[6];
  const prefix = version === 1 ? 10 : version === 2 ? 12 : 0;

  if (!prefix) {
    throw Error("Unsupported NPY version");
  }

  const length =
    version === 1 ? view.getUint16(8, true) : view.getUint32(8, true);
  const start = prefix + length;

  if (length > 1024 || start > bytes.length) {
    throw Error("Invalid NPY header");
  }

  const header = decoder.decode(bytes.subarray(prefix, start));
  const dtype = header.match(/'descr':\s*'([<|])([fiuUb])(\d+)'/);
  const shapeText = header.match(/'shape':\s*\(([\d,\s]*)\)/);

  if (!dtype || !shapeText || !/'fortran_order':\s*(False|True)/.test(header)) {
    throw Error("Use little-endian numeric arrays");
  }

  const shape = shapeText[1]
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map(Number);
  const kind = dtype[2];
  const width = Number(dtype[3]);
  const size = shape.reduce((a, b) => a * b, 1);
  const stride = kind === "U" ? 4 * width : width;

  if (
    !Number.isSafeInteger(size) ||
    size < 0 ||
    stride < 1 ||
    size * stride !== bytes.length - start ||
    size * stride > LIMIT
  ) {
    throw Error("Invalid array dimensions");
  }

  if (kind === "U") {
    if (shape.length || width > 40) {
      throw Error("Use bounded scalar strings");
    }

    let value = "";

    for (let i = 0; i < width; i++) {
      const code = view.getUint32(start + i * 4, true);

      if (code) {
        value += String.fromCodePoint(code);
      }
    }

    return { data: value, shape, dtype: "U" };
  }

  if (shape.length > 2) {
    throw Error("Use scalar, vector or matrix arrays");
  }

  const Type =
    kind === "f"
      ? width === 4
        ? Float32Array
        : width === 8
          ? Float64Array
          : null
      : kind === "b" && width === 1
        ? Uint8Array
        : ["i", "u"].includes(kind)
          ? (
              {
                1: kind === "i" ? Int8Array : Uint8Array,
                2: kind === "i" ? Int16Array : Uint16Array,
                4: kind === "i" ? Int32Array : Uint32Array,
                8: Float64Array,
              } as Record<
                number,
                | Int8ArrayConstructor
                | Uint8ArrayConstructor
                | Int16ArrayConstructor
                | Uint16ArrayConstructor
                | Int32ArrayConstructor
                | Uint32ArrayConstructor
                | Float64ArrayConstructor
              >
            )[width]
          : null;

  if (!Type) {
    throw Error("Unsupported numeric dtype");
  }

  const data = new Type(size);

  for (let i = 0; i < size; i++) {
    const offset = start + i * width;

    data[i] =
      kind === "f"
        ? width === 4
          ? view.getFloat32(offset, true)
          : view.getFloat64(offset, true)
        : width === 8
          ? Number(
              kind === "i"
                ? view.getBigInt64(offset, true)
                : view.getBigUint64(offset, true),
            )
          : width === 4
            ? kind === "i"
              ? view.getInt32(offset, true)
              : view.getUint32(offset, true)
            : width === 2
              ? kind === "i"
                ? view.getInt16(offset, true)
                : view.getUint16(offset, true)
              : kind === "i"
                ? view.getInt8(offset)
                : view.getUint8(offset);
  }

  if (shape.length === 2 && /'fortran_order':\s*True/.test(header)) {
    const copy = data.slice();

    for (let row = 0; row < shape[0]; row++) {
      for (let column = 0; column < shape[1]; column++) {
        data[row * shape[1] + column] = copy[column * shape[0] + row];
      }
    }
  }

  return { data, shape, dtype: kind as NumericKind, width };
}

export function decodeArchive(bytes: Uint8Array): Archive {
  if (bytes.length > LIMIT) {
    throw Error("Checkpoint exceeds 64 MiB");
  }

  let expanded = 0;
  const names = new Set();
  const files = unzipSync(bytes, {
    filter: (file) => {
      if (
        names.size >= 32 ||
        names.has(file.name) ||
        !/^\w+\.npy$/.test(file.name)
      ) {
        throw Error("Invalid or duplicate array name");
      }

      names.add(file.name);
      expanded += file.originalSize;

      if (expanded > LIMIT) {
        throw Error("Archive expands beyond 64 MiB");
      }

      return true;
    },
  });

  return Object.fromEntries(
    Object.entries(files).map(([name, value]) => [
      name.slice(0, -4),
      decodeArray(value),
    ]),
  );
}

export function encodeArray(
  data: ExportArray["data"],
  shape: number[] = [],
  dtype = "<f8",
) {
  const string = dtype.startsWith("<U");
  const width = Number(dtype.slice(2));
  const size = shape.reduce((a, b) => a * b, 1);
  const stride = string ? width * 4 : width;
  let header = `{'descr': '${dtype}', 'fortran_order': False, 'shape': (${shape.join(", ")}${shape.length === 1 ? "," : ""}), }`;
  header += `${" ".repeat((64 - ((10 + header.length + 1) % 64)) % 64)}\n`;
  const bytes = new Uint8Array(10 + header.length + size * stride);
  const view = new DataView(bytes.buffer);
  bytes.set([147, 78, 85, 77, 80, 89, 1, 0]);
  view.setUint16(8, header.length, true);
  bytes.set(new TextEncoder().encode(header), 10);
  const start = 10 + header.length;

  if (string) {
    if (typeof data !== "string") {
      throw Error("String export requires string data");
    }

    for (let i = 0; i < data.length; i++) {
      view.setUint32(start + 4 * i, data.codePointAt(i)!, true);
    }
  } else {
    if (typeof data === "string") {
      throw Error("Numeric export requires numeric data");
    }

    for (let i = 0; i < size; i++) {
      const value = typeof data === "number" ? data : data[i];
      const offset = start + i * width;
      const method = setters[dtype as keyof typeof setters];

      if (!method) {
        throw Error("Unsupported export dtype");
      }

      view[method](offset, value, true);
    }
  }

  return bytes;
}

export function encodeArchive(arrays: Record<string, ExportArray>) {
  return zipSync(
    Object.fromEntries(
      Object.entries(arrays).map(([key, { data, shape, dtype }]) => [
        `${key}.npy`,
        encodeArray(data, shape, dtype),
      ]),
    ),
    { level: 6, mtime: new Date(1980, 0, 1) },
  );
}
