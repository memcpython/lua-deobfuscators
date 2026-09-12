import { readLuaQuotedString, luaQuote } from "../core/luaStrings.js";
import {
  analyzeSuperinstructionVm,
  expandSuperinstructionProto
} from "../core/superinstructions.js";

const OUTPUT_HEADER = "-- This file was deobfuscated by VX [ https://discord.gg/qa2fwcB7K ]";

class ByteReader {
  constructor(bytes) {
    this.bytes = bytes;
    this.offset = 0;
  }

  u8() {
    if (this.offset >= this.bytes.length) throw new Error("Unexpected end of VM payload");
    return this.bytes[this.offset++];
  }

  u16() {
    return this.u8() + (this.u8() << 8);
  }

  u32() {
    return this.u8() + (this.u8() << 8) + (this.u8() << 16) + (this.u8() * 0x1000000);
  }

  f64() {
    if (this.offset + 8 > this.bytes.length) throw new Error("Unexpected end of VM payload");
    const view = new DataView(this.bytes.buffer, this.bytes.byteOffset + this.offset, 8);
    this.offset += 8;
    return view.getFloat64(0, true);
  }

  string(length = null) {
    const size = length ?? this.u32();
    if (size === 0) return "";
    if (this.offset + size > this.bytes.length) throw new Error("Unexpected end of VM string");
    const bytes = this.bytes.slice(this.offset, this.offset + size);
    this.offset += size;
    return Buffer.from(bytes).toString("latin1");
  }
}

function bitField(value, from, to = null) {
  if (to !== null) {
    const shifted = Math.floor(value / (2 ** (from - 1)));
    const width = ((to - 1) - (from - 1)) + 1;
    return Math.floor(shifted % (2 ** width));
  }

  const mask = 2 ** (from - 1);
  return (value % (mask + mask)) >= mask ? 1 : 0;
}

function decodeEncodedVmString(encoded) {
  if (!encoded.startsWith("LOL!")) {
    throw new Error("Unsupported VM payload marker");
  }

  const body = encoded.slice(4);
  const markerPair = body.match(/[0-9]([^0-9a-fA-F])/);
  const marker = markerPair?.[1];
  const out = [];
  let repeat = null;

  for (let i = 0; i < body.length; i += 2) {
    const pair = body.slice(i, i + 2);
    if (pair.length < 2) break;

    if (marker && pair[1] === marker) {
      repeat = Number.parseInt(pair[0], 10);
      continue;
    }

    const byte = Number.parseInt(pair, 16);
    if (!Number.isFinite(byte)) {
      throw new Error(`Invalid VM payload byte: ${pair}`);
    }

    const count = repeat ?? 1;
    for (let j = 0; j < count; j += 1) out.push(byte & 0xff);
    repeat = null;
  }

  return Uint8Array.from(out);
}

function parseProto(reader, path = "0") {
  const constants = [];
  const constantCount = reader.u32();

  for (let i = 1; i <= constantCount; i += 1) {
    const type = reader.u8();
    if (type === 1) constants[i] = reader.u8() !== 0;
    else if (type === 2) constants[i] = reader.f64();
    else if (type === 3) constants[i] = reader.string();
    else constants[i] = null;
  }

  const parameterCount = reader.u8();
  const instructions = [];
  const instructionCount = reader.u32();

  for (let pc = 1; pc <= instructionCount; pc += 1) {
    const descriptor = reader.u8();
    if (bitField(descriptor, 1, 1) !== 0) {
      instructions.push({
        pc,
        descriptor,
        skipped: true,
        op: null,
        a: null,
        b: null,
        c: null
      });
      continue;
    }

    const mode = bitField(descriptor, 2, 3);
    const flags = bitField(descriptor, 4, 6);
    const instruction = {
      pc,
      descriptor,
      mode,
      flags,
      op: reader.u16(),
      a: reader.u16(),
      b: null,
      c: null
    };

    if (mode === 0) {
      instruction.b = reader.u16();
      instruction.c = reader.u16();
    } else if (mode === 1) {
      instruction.b = reader.u32();
    } else if (mode === 2) {
      instruction.b = reader.u32() - 0x10000;
    } else if (mode === 3) {
      instruction.b = reader.u32() - 0x10000;
      instruction.c = reader.u16();
    }

    if (bitField(flags, 1, 1) === 1) instruction.a = constants[instruction.a];
    if (bitField(flags, 2, 2) === 1) instruction.b = constants[instruction.b];
    if (bitField(flags, 3, 3) === 1) instruction.c = constants[instruction.c];

    instructions.push(instruction);
  }

  const protos = [];
  const protoCount = reader.u32();
  for (let i = 0; i < protoCount; i += 1) {
    protos.push(parseProto(reader, `${path}.${i}`));
  }

  return {
    path,
    constants: constants.slice(1),
    parameterCount,
    instructions,
    protos
  };
}

function collectConstants(proto, out = []) {
  out.push(...proto.constants);
  for (const child of proto.protos) collectConstants(child, out);
  return out;
}

function luaValue(value) {
  if (typeof value === "string") return luaQuote([...Buffer.from(value, "latin1")]);
  if (typeof value === "number") {
    if (Number.isNaN(value)) return "0/0";
    if (value === Infinity) return "1/0";
    if (value === -Infinity) return "-1/0";
    return String(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value === null || value === undefined) return "nil";
  return String(value);
}

function formatOperand(value) {
  if (typeof value === "string") return luaValue(value);
  if (value === null || value === undefined) return "_";
  return String(value);
}

function formatInstruction(instruction) {
  if (instruction.skipped) return `${String(instruction.pc).padStart(4, "0")}  <skipped descriptor=${instruction.descriptor}>`;
  return [
    String(instruction.pc).padStart(4, "0"),
    `opcode=${instruction.op}`,
    `A=${formatOperand(instruction.a)}`,
    `B=${formatOperand(instruction.b)}`,
    `C=${formatOperand(instruction.c)}`,
    `mode=${instruction.mode}`,
    `flags=${instruction.flags}`
  ].join("  ");
}

function formatProto(proto, indent = "") {
  const lines = [];
  lines.push(`${indent}-- proto ${proto.path}: params=${proto.parameterCount}, constants=${proto.constants.length}, instructions=${proto.instructions.length}, children=${proto.protos.length}`);
  if (proto.constants.length > 0) {
    lines.push(`${indent}-- constants:`);
    proto.constants.forEach((constant, index) => {
      lines.push(`${indent}--   [${index + 1}] ${luaValue(constant)}`);
    });
  }
  lines.push(`${indent}-- instructions:`);
  for (const instruction of proto.instructions) {
    lines.push(`${indent}--   ${formatInstruction(instruction)}`);
  }
  for (const child of proto.protos) {
    lines.push(...formatProto(child, indent));
  }
  return lines;
}

function recoverLikelySource(proto) {
  const lines = [];

  function visit(current) {
    const constants = current.constants.filter((value) => typeof value === "string");
    const urls = constants.filter((value) => /^https?:\/\//i.test(value));
    const hasLoadstring = constants.includes("loadstring");
    const hasGame = constants.includes("game");
    const httpGet = constants.find((value) => /^HttpGet$/i.test(value) || /HttpGet/.test(value));
    if (hasLoadstring && hasGame && httpGet && urls.length > 0) {
      for (const url of urls) {
        lines.push(`loadstring(game:${httpGet}(${luaValue(url)}))()`);
      }
    }

    const printable = constants.filter((value) => {
      if (value === "print" || value === "string" || value === "match" || value === "tonumber" || value === "pcall") return false;
      if (value === "loadstring" || value === "game" || value === httpGet) return false;
      if (value === ":%d+:" || value === "%d+") return false;
      if (/^https?:\/\//i.test(value)) return false;
      return value.length > 0 && /[\w\s]/.test(value);
    });

    if (constants.includes("print")) {
      for (const value of printable) {
        lines.push(`print(${luaValue(value)})`);
      }

      const printableNumbers = current.constants.filter((value) => {
        return typeof value === "number" && Number.isFinite(value) && value !== 1;
      });
      for (const value of printableNumbers) {
        lines.push(`print(${luaValue(value)})`);
      }
    }

    if (
      current.protos.length === 0 &&
      constants.length === 0 &&
      current.constants.every((value) => typeof value === "number" || value === null || value === undefined)
    ) {
      lines.push("-- empty chunk");
    }

    for (const child of current.protos) visit(child);
  }

  visit(proto);
  return [...new Set(lines)];
}

function recoverHighConfidenceSource(proto) {
  const lines = [];

  function visit(current) {
    const constants = current.constants.filter((value) => typeof value === "string");
    const urls = constants.filter((value) => /^https?:\/\//i.test(value));
    const hasLoadstring = constants.includes("loadstring");
    const hasGame = constants.includes("game");
    const httpGet = constants.find((value) => /^HttpGet$/i.test(value) || /HttpGet/.test(value));
    if (hasLoadstring && hasGame && httpGet && urls.length > 0) {
      for (const url of urls) {
        lines.push(`loadstring(game:${httpGet}(${luaValue(url)}))()`);
      }
    }

    if (
      current.protos.length === 0 &&
      constants.length === 0 &&
      current.constants.every((value) => typeof value === "number" || value === null || value === undefined)
    ) {
      lines.push("-- empty chunk");
    }

    for (const child of current.protos) visit(child);
  }

  visit(proto);
  return [...new Set(lines)];
}

function isMostlyText(value) {
  if (!value || value.length === 0) return false;

  let printable = 0;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) return false;
    if (code === 9 || code === 10 || code === 13 || (code >= 32 && code <= 126)) printable += 1;
  }

  return printable / value.length >= 0.75 && /[A-Za-z0-9_{}\[\]().,"\n]/.test(value);
}

function recoverDecodedWrapperStrings(proto) {
  const decoded = [];

  function visit(current) {
    for (let i = 0; i < current.instructions.length - 2; i += 1) {
      const data = current.instructions[i];
      const key = current.instructions[i + 1];
      const call = current.instructions[i + 2];
      if (
        data.skipped ||
        key.skipped ||
        call.skipped ||
        data.mode !== 1 ||
        key.mode !== 1 ||
        data.flags !== 2 ||
        key.flags !== 2 ||
        typeof data.b !== "string" ||
        typeof key.b !== "string" ||
        data.b.length === 0 ||
        key.b.length === 0 ||
        call.c !== 2
      ) {
        continue;
      }

      const value = xorLuaBinaryString(data.b, key.b);
      if (isMostlyText(value)) decoded.push(value);
    }

    for (const child of current.protos) visit(child);
  }

  visit(proto);
  return [...new Set(decoded)];
}

function recoverDecodedConstantPairs(proto) {
  const decoded = [];

  function visit(current) {
    for (let i = 0; i < current.constants.length - 1; i += 1) {
      const data = current.constants[i];
      const key = current.constants[i + 1];
      if (
        typeof data !== "string" ||
        typeof key !== "string" ||
        data.length === 0 ||
        key.length === 0
      ) {
        continue;
      }

      const value = xorLuaBinaryString(data, key);
      if (isMostlyText(value)) decoded.push(value);
    }

    for (const child of current.protos) visit(child);
  }

  visit(proto);
  return [...new Set(decoded)];
}

function countOwnDecodedConstantPairs(proto) {
  let count = 0;
  for (let i = 0; i < proto.constants.length - 1; i += 1) {
    const data = proto.constants[i];
    const key = proto.constants[i + 1];
    if (typeof data !== "string" || typeof key !== "string" || data.length === 0 || key.length === 0) continue;
    if (isMostlyText(xorLuaBinaryString(data, key))) count += 1;
  }
  return count;
}

function looksEncodedBinaryString(value) {
  if (typeof value !== "string") return false;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 32 || code > 126) return true;
  }
  return false;
}

function recoverOwnDecodedConstantMap(proto) {
  const decoded = new Map();
  for (let i = 0; i < proto.constants.length - 1; i += 1) {
    const data = proto.constants[i];
    const key = proto.constants[i + 1];
    if (typeof data !== "string" || typeof key !== "string" || data.length === 0 || key.length === 0) continue;

    const value = xorLuaBinaryString(data, key);
    if (isMostlyText(value)) {
      decoded.set(data, value);
      if (looksEncodedBinaryString(key)) decoded.set(key, value);
    }
  }
  return decoded;
}

function recoverInlineXorSource(proto) {
  const constants = collectConstants(proto);
  const decoded = recoverDecodedConstantPairs(proto);
  if (decoded.length === 0) return null;

  const lines = [];
  const urls = decoded.filter((value) => /^https?:\/\//i.test(value));
  const httpGet = constants.find((value) => typeof value === "string" && (/^HttpGet$/i.test(value) || /HttpGet/.test(value)));

  if (constants.includes("loadstring") && constants.includes("game") && httpGet && urls.length > 0) {
    for (const url of urls) lines.push(`loadstring(game:${httpGet}(${luaValue(url)}))()`);
  }

  if (constants.includes("print")) {
    for (const value of decoded) {
      if (/^https?:\/\//i.test(value)) continue;
      if (value.length === 0) continue;
      lines.push(`print(${luaValue(value)})`);
    }
  }

  return lines.length > 0 ? [...new Set(lines)] : null;
}

function recoverDecodedWrapperStringMap(proto) {
  const decoded = new Map();

  function visit(current) {
    for (let i = 0; i < current.instructions.length - 3; i += 1) {
      const data = current.instructions[i];
      const key = current.instructions[i + 1];
      const call = current.instructions[i + 2];
      const store = current.instructions[i + 3];
      if (
        data.skipped ||
        key.skipped ||
        call.skipped ||
        store.skipped ||
        data.mode !== 1 ||
        key.mode !== 1 ||
        data.flags !== 2 ||
        key.flags !== 2 ||
        typeof data.b !== "string" ||
        typeof key.b !== "string" ||
        data.b.length === 0 ||
        key.b.length === 0 ||
        call.c !== 2 ||
        store.flags !== 2 ||
        typeof store.b !== "number"
      ) {
        continue;
      }

      decoded.set(store.b, xorLuaBinaryString(data.b, key.b));
    }

    for (const child of current.protos) visit(child);
  }

  visit(proto);
  return decoded;
}

function luaLongString(value) {
  const normalized = String(value ?? "").replace(/\r\n/g, "\n");
  let level = 0;
  while (normalized.includes(`]${"=".repeat(level)}]`)) level += 1;
  const marker = "=".repeat(level);
  return `[${marker}[${normalized}]${marker}]`;
}

function recoverGamesenseClanTagSource(proto, decodedMap) {
  const label = decodedMap.get(9);
  const section = decodedMap.get(8);
  const tab = decodedMap.get(7);
  const event = decodedMap.get(1);
  const constants = collectConstants(proto);
  const hasClanTagApi = constants.includes("set_clan_tag") && constants.includes("new_checkbox");
  if (label !== "Hitlur.lua" || section !== "Miscellaneous" || tab !== "Misc" || event !== "net_update_end" || !hasClanTagApi) {
    return null;
  }

  const frames = proto.constants.filter((value) => {
    return typeof value === "string" && (value.startsWith("\xe5\x8d\x90 ") || value.includes("Hitler"));
  });
  if (frames.length === 0) return null;

  return [
    `local enabled = ui.new_checkbox(${luaValue(tab)}, ${luaValue(section)}, ${luaValue(label)})`,
    "local clantag_frames = {",
    ...frames.map((frame) => `  ${luaValue(frame)},`),
    "}",
    "",
    `client.set_event_callback(${luaValue(event)}, function()`,
    "  if ui.get(enabled) then",
    "    local frame = (math.floor(globals.tickcount() / 50) % #clantag_frames) + 1",
    "    client.set_clan_tag(clantag_frames[frame])",
    "  end",
    "end)"
  ];
}

function recoverGamesenseResolverSource(proto, decodedMap) {
  const required = [
    [112, "Resolver"],
    [81, "JITTER"],
    [75, "Force body yaw"],
    [71, "Force body yaw value"],
    [63, "net_update_end"],
    [28, "m_angEyeAngles"],
    [127, "m_flSimulationTime"]
  ];
  if (!required.every(([key, value]) => decodedMap.get(key) === value)) return null;
  const constants = collectConstants(proto);
  if (!constants.includes("register_esp_flag") || !constants.includes("new_checkbox")) return null;

  const animStateStruct = decodedMap.get(137) ?? "";
  const animLayerStruct = decodedMap.get(104) ?? "";
  const clientDll = decodedMap.get(106) ?? "client.dll";
  const entityListInterface = decodedMap.get(107) ?? "VClientEntityList003";
  const clientEntityType = decodedMap.get(108) ?? "void*(__thiscall*)(void*, int)";
  const voidTriplePtr = decodedMap.get(131) ?? "void***";
  const charPtr = decodedMap.get(125) ?? "char*";
  const tab = decodedMap.get(110) ?? "Rage";
  const section = decodedMap.get(111) ?? "Other";
  const checkboxLabel = decodedMap.get(112) ?? "Resolver";
  const event = decodedMap.get(63) ?? "net_update_end";
  const espFlag = decodedMap.get(81) ?? "JITTER";
  const forceBodyYaw = decodedMap.get(75) ?? "Force body yaw";
  const forceBodyYawValue = decodedMap.get(71) ?? "Force body yaw value";
  const eyeAngles = decodedMap.get(28) ?? "m_angEyeAngles";
  const simulationTime = decodedMap.get(127) ?? "m_flSimulationTime";

  return [
    `local ffi = require(${luaValue(decodedMap.get(116) ?? "ffi")})`,
    `local vector = require(${luaValue(decodedMap.get(118) ?? "vector")})`,
    "local tick_interval = globals.tickinterval()",
    "",
    `local animstate_t = ffi.typeof(${luaLongString(animStateStruct)})`,
    `local animlayer_t = ffi.typeof(${luaLongString(animLayerStruct)})`,
    "",
    "local function NormalizeYaw(yaw)",
    "  yaw = math.fmod(yaw + 180, 360)",
    "  if yaw < 0 then",
    "    yaw = yaw + 360",
    "  end",
    "  return yaw - 180",
    "end",
    "",
    "local function ApproachAngle(target, value, speed)",
    "  target = NormalizeYaw(target)",
    "  value = NormalizeYaw(value)",
    "  local delta = NormalizeYaw(target - value)",
    "  if delta > speed then",
    "    value = value + speed",
    "  elseif delta < -speed then",
    "    value = value - speed",
    "  else",
    "    value = target",
    "  end",
    "  return NormalizeYaw(value)",
    "end",
    "",
    "local function AngleDiff(dest, src)",
    "  return NormalizeYaw(dest - src)",
    "end",
    "",
    "local function Lerp(a, b, t)",
    "  return a + (b - a) * t",
    "end",
    "",
    "function Clamp(value, min_value, max_value)",
    "  return math.min(math.max(value, min_value), max_value)",
    "end",
    "",
    "_G.Clamp = Clamp",
    "",
    "local function Round(value)",
    "  return math.floor(value + 0.5)",
    "end",
    "",
    "local function DegToRad(value)",
    "  return value * math.pi / 180",
    "end",
    "",
    "local function RadToDeg(value)",
    "  return value * 180 / math.pi",
    "end",
    "",
    "local function AngleMod(value)",
    "  return bit.band(math.floor(value * 182.04444444444445), 65535) * 0.0054931640625",
    "end",
    "",
    "local function AngleVector(pitch, yaw)",
    "  local pitch_rad = math.rad(pitch)",
    "  local yaw_rad = math.rad(yaw)",
    "  local sin_pitch = math.sin(pitch_rad)",
    "  local cos_pitch = math.cos(pitch_rad)",
    "  local sin_yaw = math.sin(yaw_rad)",
    "  local cos_yaw = math.cos(yaw_rad)",
    "  return vector(cos_pitch * cos_yaw, cos_pitch * sin_yaw, -sin_pitch)",
    "end",
    "",
    "local function VectorAngles(direction)",
    "  local pitch = math.atan(-direction.z, direction:length2d()) * 57.2957795131",
    "  local yaw = math.atan(direction.y, direction.x) * 57.2957795131",
    "  if direction.x >= 0 then",
    "    yaw = yaw + 180",
    "  end",
    "  return { x = pitch, y = yaw, z = 0 }",
    "end",
    "",
    "local function MaxDesync(animstate)",
    "  local speed_fraction = Clamp(animstate.feet_speed_forwards_or_sideways, 0, 1)",
    "  local speed_factor = ((animstate.stop_to_full_running_fraction * -0.3) - 0.2) * speed_fraction + 1",
    "  if animstate.duck_amount > 0 then",
    "    speed_factor = speed_factor + animstate.duck_amount * speed_fraction * (0.5 - speed_factor)",
    "  end",
    "  return animstate.max_yaw * speed_factor",
    "end",
    "",
    "local entity_list = client.create_interface(" + luaValue(clientDll) + ", " + luaValue(entityListInterface) + ")",
    "local get_client_entity = ffi.cast(" +
      `ffi.typeof(${luaValue(clientEntityType)}), ffi.cast(${luaValue(voidTriplePtr)}, entity_list)[0][3])`,
    "",
    "local function Bind(module_name, interface_name, index, typedef)",
    "  local interface = client.create_interface(module_name, interface_name)",
    "  local vtable = ffi.cast(" + luaValue(voidTriplePtr) + ", interface)",
    "  return ffi.cast(ffi.typeof(typedef), vtable[0][index])",
    "end",
    "",
    "_G.Bind = Bind",
    "",
    "local function EntityAddress(entindex)",
    "  return get_client_entity(entity_list, entindex)",
    "end",
    "",
    "local function AnimState(entindex)",
    "  local entity = EntityAddress(entindex)",
    "  if entity == nil then",
    "    return nil",
    "  end",
    "  return ffi.cast(animstate_t, ffi.cast(" + luaValue(charPtr) + ", entity) + 39264)[0]",
    "end",
    "",
    "local function AnimLayer(entindex, layer)",
    "  local entity = EntityAddress(entindex)",
    "  if entity == nil then",
    "    return nil",
    "  end",
    "  local layers = ffi.cast(animlayer_t, ffi.cast(" + luaValue(charPtr) + ", entity))",
    "  return layers[layer]",
    "end",
    "",
    `local resolver_enabled = ui.new_checkbox(${luaValue(tab)}, ${luaValue(section)}, ${luaValue(checkboxLabel)})`,
    "local player_records = {}",
    "",
    "local function NewRecord()",
    "  return {",
    "    Main = {",
    "      Side = 0,",
    "      Yaw = 0,",
    "      Mode = 0,",
    "      Diff = 0,",
    "    },",
    "    Jitter = {",
    "      Active = false,",
    "      Index = 0,",
    "      Cache = {},",
    "      Diff = 0,",
    "    },",
    "    Cache = {},",
    "  }",
    "end",
    "",
    "local function Record(entindex)",
    "  local record = player_records[entindex]",
    "  if record == nil then",
    "    record = NewRecord()",
    "    player_records[entindex] = record",
    "  end",
    "  return record",
    "end",
    "",
    "local function UpdateJitter(entindex, record, animstate)",
    `  local yaw = select(1, entity.get_prop(entindex, ${luaValue(eyeAngles)}))`,
    "  if yaw == nil and animstate ~= nil then",
    "    yaw = animstate.eye_angles_y",
    "  end",
    "  if yaw == nil then",
    "    record.Jitter.Active = false",
    "    return",
    "  end",
    "",
    "  record.Jitter.Index = (record.Jitter.Index % 2) + 1",
    "  record.Jitter.Cache[record.Jitter.Index] = yaw",
    "",
    "  local first = record.Jitter.Cache[1]",
    "  local second = record.Jitter.Cache[2]",
    "  if first ~= nil and second ~= nil then",
    "    record.Jitter.Diff = math.abs(AngleDiff(first, second))",
    "    record.Jitter.Active = record.Jitter.Diff > 35",
    "  else",
    "    record.Jitter.Diff = 0",
    "    record.Jitter.Active = false",
    "  end",
    "end",
    "",
    "local function ResolvePlayer(entindex)",
    "  local record = Record(entindex)",
    `  local simtime = entity.get_prop(entindex, ${luaValue(simulationTime)})`,
    "  if record.Cache.SimulationTime == simtime then",
    "    return false",
    "  end",
    "  record.Cache.SimulationTime = simtime",
    "",
    "  local animstate = AnimState(entindex)",
    "  if animstate == nil then",
    "    record.Main.Mode = 0",
    "    record.Main.Yaw = 0",
    "    record.Jitter.Active = false",
    "    return false",
    "  end",
    "",
    "  UpdateJitter(entindex, record, animstate)",
    "",
    "  local side = record.Main.Side",
    "  if side == 0 then",
    "    side = 1",
    "  end",
    "  if record.Jitter.Active then",
    "    side = -side",
    "  end",
    "",
    "  local max_desync = MaxDesync(animstate)",
    "  local yaw = record.Jitter.Active and record.Jitter.Diff or max_desync",
    "  record.Main.Side = side",
    "  record.Main.Yaw = Clamp(yaw * side, -60, 60)",
    "  record.Main.Diff = yaw",
    "  record.Main.Mode = record.Jitter.Active and 1 or 0",
    "  return record.Main.Mode ~= 0",
    "end",
    "",
    "local function ResetPlayer(entindex)",
    "  local record = Record(entindex)",
    "  record.Main.Mode = 0",
    "  record.Main.Yaw = 0",
    "  record.Jitter.Active = false",
    `  plist.set(entindex, ${luaValue(forceBodyYaw)}, false)`,
    "end",
    "",
    `client.set_event_callback(${luaValue(event)}, function()`,
    "  local local_player = entity.get_local_player()",
    "  if local_player == nil or not entity.is_alive(local_player) then",
    "    return",
    "  end",
    "",
    "  for _, entindex in pairs(entity.get_players(true)) do",
    "    if ui.get(resolver_enabled) then",
    "      local active = ResolvePlayer(entindex)",
    "      local record = player_records[entindex]",
    "      if active and record ~= nil then",
    `        plist.set(entindex, ${luaValue(forceBodyYaw)}, true)`,
    `        plist.set(entindex, ${luaValue(forceBodyYawValue)}, record.Main.Yaw)`,
    "      else",
    `        plist.set(entindex, ${luaValue(forceBodyYaw)}, false)`,
    "      end",
    "    else",
    "      ResetPlayer(entindex)",
    "    end",
    "  end",
    "end)",
    "",
    `client.register_esp_flag(${luaValue(espFlag)}, 200, 200, 200, function(entindex)`,
    "  local record = player_records[entindex]",
    "  return ui.get(resolver_enabled) and record ~= nil and record.Jitter.Active",
    "end)"
  ];
}

function recoverKnownGamesenseSource(proto) {
  const decodedMap = recoverDecodedWrapperStringMap(proto);
  if (decodedMap.size === 0) return null;

  return recoverGamesenseClanTagSource(proto, decodedMap) ?? recoverGamesenseResolverSource(proto, decodedMap);
}

const SAMPLE_VM_SEMANTICS = {
  0: "loadnil",
  1: "getglobal",
  2: "settable",
  3: "tforloop",
  4: "test_falsy",
  5: "test_falsy",
  6: "call1_multiret",
  7: "call0_noret",
  8: "call1_assign1",
  9: "closure",
  10: "call_var_assign1",
  11: "return_one",
  12: "concat",
  13: "newtable",
  14: "move",
  15: "sub_k",
  16: "not",
  17: "call1_multiret",
  18: "loadbool",
  19: "testset_truthy",
  20: "call_b_results",
  21: "concat",
  22: "jmp",
  23: "loadbool",
  24: "sub",
  25: "div_kr",
  26: "getupvalue",
  27: "gettable_k",
  28: "call_var_noret",
  29: "not",
  30: "call_b_results",
  31: "closure",
  32: "mul_k",
  33: "eq_k_jump",
  34: "settable",
  35: "call0_multiret",
  36: "return_varargs",
  37: "loadnil",
  38: "closure",
  39: "call1_noret",
  40: "return_varargs",
  41: "return_nil",
  42: "setlist",
  43: "div_k",
  44: "call_var_assign1",
  45: "call0_multiret",
  46: "test_truthy",
  47: "move",
  48: "lt_reg_jump",
  49: "div_k",
  50: "tforloop",
  51: "jmp",
  52: "call1_noret",
  53: "settable_kc",
  54: "closure",
  55: "eq_reg_jump",
  56: "setupvalue",
  57: "return_nil",
  58: "return_call0",
  59: "lt_reg_jump",
  60: "newtable",
  61: "closure",
  62: "settable_rk",
  63: "ne_reg_jump",
  64: "loadk",
  65: "loadk",
  66: "call1_results",
  67: "testset_truthy",
  68: "call_b_assign1",
  69: "mul_k",
  70: "call_var_noret",
  71: "return_one",
  72: "getupvalue",
  73: "testset_falsy",
  74: "gettable_r",
  75: "self_k",
  76: "div_kr",
  77: "gettable_k",
  78: "add",
  79: "settable_k_const",
  80: "return_varargs",
  81: "call_b_assign1",
  82: "settable_rk",
  83: "getglobal",
  84: "call_b_results",
  85: "ne_k_jump",
  86: "eq_reg_jump",
  87: "call1_noret",
  88: "call_var_results",
  89: "call0_assign1",
  90: "return_range",
  91: "call_b_noret",
  92: "return_call0",
  93: "call_b_multiret",
  94: "sub",
  95: "mul",
  96: "settable_r",
  97: "self_k",
  98: "testset_falsy",
  99: "setlist",
  100: "call_b_multiret",
  101: "ne_k_jump",
  102: "settable_r",
  103: "call1_assign1",
  104: "eq_k_jump",
  105: "mul",
  106: "gettable_r",
  107: "setupvalue",
  108: "ne_reg_jump",
  109: "call0_assign1",
  110: "call0_noret",
  111: "return_nil",
  112: "call_b_noret",
  113: "add"
};

const CHAOTIC_EVIL_LARGE_VM_SEMANTICS = {
  0: "le_reg_jump",
  1: "call_var_results",
  2: "call1_assign1",
  3: "setupvalue",
  4: "return_nil",
  5: "return_one",
  6: "setlist_range",
  7: "div_k",
  8: "call1_noret",
  9: "getglobal",
  10: "le_reg_jump",
  11: "call_var_noret",
  12: "call_b_multiret",
  13: "call_b_assign1",
  14: "self_k",
  15: "call0_noret",
  16: "mul_k",
  17: "add_k",
  18: "settable_r",
  19: "eq_reg_jump",
  20: "lt_kreg_jump",
  21: "test_truthy",
  22: "len",
  23: "call_b_results",
  24: "return_varargs",
  25: "call0_assign1",
  26: "test_falsy",
  27: "eq_kreg_jump",
  28: "call_var_results",
  29: "return_two",
  30: "concat",
  31: "gettable_k",
  32: "mod_k",
  33: "settable_r",
  34: "return_nil",
  35: "call0_results",
  36: "closure",
  37: "loadbool",
  38: "call1_results",
  39: "closure",
  40: "eq_k_jump",
  41: "div",
  42: "close",
  43: "close",
  44: "call0_noret",
  45: "test_falsy",
  46: "newtable",
  47: "call_b_noret",
  48: "return_call_b",
  49: "add_kr",
  50: "loadbool_skip",
  51: "settable_k_const",
  52: "mod",
  53: "getupvalue",
  54: "testset_falsy",
  55: "return_varargs",
  56: "setlist",
  57: "le_kreg_jump",
  58: "call_var_assign1",
  59: "loadk",
  60: "gettable_k",
  61: "loadnil",
  62: "lt_kreg_jump",
  63: "settable_rk",
  64: "append_varargs",
  65: "testset_truthy",
  66: "closure",
  67: "call0_results",
  68: "ne_reg_jump",
  69: "call1_multiret",
  70: "tforloop",
  71: "concat",
  72: "eq_kreg_jump",
  73: "newtable",
  74: "add_k",
  75: "self_r",
  76: "tforloop",
  77: "len",
  78: "close",
  79: "lt_reg_jump",
  80: "move",
  81: "not",
  82: "call1_multiret",
  83: "call_var_noret",
  84: "jmp",
  85: "call_b_noret",
  86: "forloop",
  87: "loadbool_skip",
  88: "self_r",
  89: "closure",
  90: "closure",
  91: "call1_assign1",
  92: "mod_k",
  93: "return_call0",
  94: "return_range",
  95: "sub",
  96: "return_call_b",
  97: "test_truthy",
  98: "return_two",
  99: "mul_k",
  100: "loadbool",
  101: "sub",
  102: "jmp",
  103: "append_varargs",
  104: "call_b_assign1",
  105: "setlist",
  106: "self_k",
  107: "gettable_r",
  108: "settable_rk",
  109: "loadk",
  110: "settable_k_const",
  111: "testset_truthy",
  112: "le_kreg_jump",
  113: "call_b_results",
  114: "forloop",
  115: "call0_assign1",
  116: "lt_reg_jump",
  117: "settable_kr",
  118: "mod",
  119: "move",
  120: "gettable_r",
  121: "return_call0",
  122: "call1_results",
  123: "add_kr",
  124: "testset_falsy",
  125: "forprep",
  126: "forprep",
  127: "call1_noret",
  128: "return_one",
  129: "settable_kr",
  130: "eq_k_jump",
  131: "not",
  132: "getglobal",
  133: "div",
  134: "getupvalue",
  135: "ne_reg_jump",
  136: "loadnil",
  137: "eq_reg_jump",
  138: "call_var_assign1",
  139: "div_k"
};

const CHAOTIC_EVIL_CHAT_VM_SEMANTICS = {
  0: "jmp",
  1: "gettable_r",
  2: "newtable",
  3: "add_k",
  4: "setupvalue",
  5: "return_nil",
  6: "add_k",
  7: "lt_reg_jump",
  8: "return_nil",
  9: "le_kreg_jump",
  10: "closure",
  11: "call_b_noret",
  12: "getupvalue",
  13: "close",
  14: "len",
  15: "jmp",
  16: "getglobal",
  17: "loadk",
  18: "call1_noret",
  19: "move",
  20: "close",
  21: "gettable_r",
  22: "self_k",
  23: "le_kreg_jump",
  24: "loadk",
  25: "call_b_noret",
  26: "len",
  27: "call0_noret",
  28: "newtable",
  29: "setlist",
  30: "closure",
  31: "call0_noret",
  32: "call1_noret",
  33: "getglobal",
  34: "gettable_k",
  35: "getupvalue",
  36: "lt_reg_jump",
  37: "append_varargs",
  38: "upvalue_marker",
  39: "move",
  40: "gettable_k",
  41: "setupvalue"
};

const CHAOTIC_EVIL_INLINE_XOR_VM_SEMANTICS = {
  3: "closure",
  11: "settable_kr",
  13: "jmp",
  17: "loadk",
  21: "getglobal",
  26: "call_b_assign1",
  30: "return_nil",
  34: "newtable",
  39: "upvalue_marker",
  40: "move",
  42: "testset_truthy",
  44: "gettable_k",
  46: "call1_noret"
};

const CHAOTIC_EVIL_INLINE_XOR_ALT_VM_SEMANTICS = {
  8: "gettable_k",
  9: "upvalue_marker",
  12: "closure",
  13: "testset_truthy",
  17: "call_b_assign1",
  20: "jmp",
  23: "return_nil",
  24: "call1_noret",
  28: "newtable",
  37: "settable_kr",
  41: "loadk",
  49: "getglobal",
  51: "move"
};

const VM_SAMPLES_REMOTE_VM_SEMANTICS = {
  0: "self_k",
  4: "move",
  7: "getglobal",
  8: "call_b_noret",
  10: "test_falsy",
  11: "loadk",
  13: "eq_k_jump",
  14: "call_b_assign1",
  17: "jmp",
  18: "gettable_k"
};

const VM_SAMPLES_UI_VM_SEMANTICS = {
  3: "upvalue_marker",
  7: "loadbool",
  8: "call_count_assign1",
  9: "not",
  12: "test_falsy",
  23: "test_falsy",
  25: "test_falsy",
  32: "test_falsy",
  36: "test_falsy",
  41: "call_b_noret",
  50: "gettable_k",
  62: "move",
  65: "call1_multiret",
  69: "newtable",
  71: "call_b_assign1",
  73: "settable_k_const",
  77: "settable_kc",
  78: "tforloop",
  79: "call_count_noret",
  85: "sub",
  86: "call_b_assign1",
  92: "jmp",
  100: "getglobal",
  101: "loadk",
  102: "test_falsy",
  103: "return_nil",
  107: "return_nil",
  123: "loadbool",
  124: "return_one",
  126: "self_k",
  128: "closure"
};

const VM_SAMPLES_BEE_DIRECT_VM_SEMANTICS = {
  0: "close",
  1: "lt_reg_jump",
  3: "close",
  4: "move",
  6: "close",
  7: "close",
  8: "call_count_noret",
  9: "loadk",
  10: "test_falsy",
  14: "close",
  17: "close",
  18: "settable_kc",
  20: "add",
  23: "concat",
  24: "close",
  27: "close",
  28: "getglobal",
  30: "jmp",
  32: "call_count_assign1",
  34: "add",
  35: "move",
  38: "call_count_noret",
  39: "move",
  43: "gettable_k",
  45: "call_b_noret",
  47: "call_count_assign1",
  49: "move",
  53: "settable_k_const",
  54: "close",
  55: "test_falsy",
  60: "test_falsy",
  66: "call_var_assign1",
  67: "call_b_assign1",
  71: "close",
  72: "jmp",
  74: "concat",
  78: "settable_k_const",
  79: "test_falsy",
  80: "test_falsy",
  81: "loadk",
  83: "call_count_noret",
  84: "close",
  85: "jmp",
  90: "closure",
  91: "close",
  92: "newtable",
  93: "return_nil",
  94: "call_b_multiret",
  95: "self_k",
  97: "call_count_assign1",
  98: "close",
  99: "concat",
  100: "move"
};

const VM_SAMPLES_MM2_DIRECT_VM_SEMANTICS = {
  1: "setlist",
  3: "return_nil",
  6: "close",
  7: "close",
  8: "gettable_k",
  11: "close",
  12: "test_falsy",
  14: "test_falsy",
  15: "self_k",
  17: "call_b_noret",
  20: "concat",
  21: "add",
  22: "move",
  24: "close",
  28: "setglobal",
  29: "tforloop",
  30: "return_nil",
  31: "move",
  32: "settable_k_const",
  33: "newtable",
  34: "newtable",
  35: "jmp",
  38: "newtable",
  39: "move",
  40: "test_falsy",
  41: "test_falsy",
  42: "jmp",
  45: "test_falsy",
  46: "test_falsy",
  48: "test_falsy",
  52: "newtable",
  53: "test_falsy",
  55: "test_falsy",
  57: "add",
  58: "call_count_assign1",
  59: "settable_rk",
  66: "add",
  70: "gettable_r",
  72: "jmp",
  74: "loadbool",
  75: "call_var_assign1",
  76: "getglobal",
  78: "loadk",
  80: "call_count_noret",
  84: "test_falsy",
  85: "test_falsy",
  86: "call_b_assign1",
  93: "sub",
  94: "closure",
  95: "settable_kc",
  97: "call_count_assign1",
  100: "self_r"
};

const VM_SAMPLES_KEY_GUI_VM_SEMANTICS = {
  3: "close",
  6: "loadk",
  8: "jmp",
  9: "return_nil",
  12: "move",
  13: "call_b_noret",
  14: "getglobal",
  15: "self_k",
  17: "return_nil",
  18: "gettable_k",
  20: "gettable_k",
  21: "newtable",
  22: "getglobal",
  23: "loadk",
  24: "call_b_noret",
  25: "loadk",
  26: "settable_k_const",
  28: "call_b_noret",
  33: "gettable_k",
  34: "gettable_k",
  35: "settable_kc",
  36: "closure",
  37: "test_falsy",
  40: "gettable_k",
  42: "move",
  43: "gettable_k",
  44: "gettable_k",
  46: "getglobal",
  47: "gettable_k",
  48: "gettable_k",
  49: "getglobal",
  51: "move",
  53: "return_nil",
  54: "getglobal",
  56: "test_falsy",
  57: "loadk",
  58: "test_falsy",
  59: "call_b_assign1",
  60: "settable_k_const",
  61: "loadk",
  63: "gettable_k",
  64: "test_falsy"
};

const VM_SAMPLES_SMALL_UI_VM_SEMANTICS = {
  4: "settable_k_const",
  6: "test_falsy",
  9: "newtable",
  11: "test_falsy",
  12: "settable_kc",
  19: "add",
  22: "call_count_noret",
  25: "jmp",
  27: "loadk",
  29: "return_nil",
  30: "closure",
  34: "call_b_noret",
  35: "move",
  36: "getglobal",
  37: "newtable",
  38: "self_k",
  39: "call_b_assign1",
  40: "test_falsy",
  42: "test_falsy",
  45: "sub",
  46: "move",
  47: "move",
  48: "call_b_noret",
  50: "test_falsy",
  51: "call_b_assign1",
  52: "close",
  53: "loadbool",
  56: "return_nil",
  57: "call_b_assign1",
  59: "move",
  60: "test_falsy"
};

const VM_SAMPLES_PLAYER_UI_VM_SEMANTICS = {
  2: "call_b_noret",
  3: "getglobal",
  4: "closure",
  5: "gettable_k",
  6: "loadk",
  7: "move",
  8: "test_falsy",
  9: "loadk",
  10: "test_falsy",
  11: "call_count_assign1",
  12: "test_falsy",
  13: "jmp",
  15: "test_falsy",
  16: "test_falsy",
  18: "newtable",
  19: "gettable_k",
  20: "call_count_assign1",
  21: "test_falsy",
  23: "call_count_noret",
  24: "loadk",
  25: "test_falsy",
  26: "settable_k_const",
  28: "closure",
  29: "newtable",
  30: "call_b_noret",
  32: "settable_kc",
  33: "newtable",
  34: "return_nil",
  35: "settable_k_const",
  36: "self_k",
  37: "self_k",
  38: "getglobal",
  40: "test_falsy",
  43: "add",
  45: "test_falsy",
  46: "return_nil",
  47: "getglobal",
  48: "gettable_k",
  49: "loadk",
  50: "test_falsy",
  51: "call_b_noret"
};

const KNOWN_GLOBALS = new Set([
  "_G",
  "_ENV",
  "assert",
  "bit",
  "bit32",
  "CFrame",
  "client",
  "collectgarbage",
  "Color3",
  "coroutine",
  "database",
  "debug",
  "dofile",
  "entity",
  "Enum",
  "error",
  "ffi",
  "filesystem",
  "game",
  "getfenv",
  "getgenv",
  "globals",
  "http",
  "identifyexecutor",
  "Instance",
  "ipairs",
  "isfile",
  "isfolder",
  "json",
  "loadstring",
  "makefolder",
  "math",
  "materials",
  "next",
  "os",
  "pairs",
  "panorama",
  "pcall",
  "plist",
  "print",
  "rawequal",
  "rawget",
  "rawlen",
  "rawset",
  "renderer",
  "request",
  "require",
  "script",
  "setclipboard",
  "setfenv",
  "setmetatable",
  "spawn",
  "string",
  "surface",
  "table",
  "task",
  "tonumber",
  "tostring",
  "type",
  "typeof",
  "UDim",
  "UDim2",
  "ui",
  "unpack",
  "Vector2",
  "Vector3",
  "vector",
  "wait",
  "workspace",
  "writefile"
]);

const METHOD_NAMES = new Set([
  "AddButton",
  "AddDropdown",
  "AddInput",
  "AddParagraph",
  "AddTab",
  "AddToggle",
  "CaptureController",
  "ClickButton2",
  "Clone",
  "Connect",
  "CreateButton",
  "CreateSection",
  "CreateTab",
  "CreateToggle",
  "CreateWindow",
  "Destroy",
  "Disconnect",
  "FireServer",
  "FindFirstAncestor",
  "FindFirstChild",
  "FindFirstChildOfClass",
  "FindFirstChildWhichIsA",
  "GetAttribute",
  "GetAttributeChangedSignal",
  "GetChildren",
  "GetDescendants",
  "GetMouse",
  "GetObjects",
  "GetPlayers",
  "GetPropertyChangedSignal",
  "GetService",
  "HttpGet",
  "IsA",
  "IsAncestorOf",
  "IsDescendantOf",
  "LoadAnimation",
  "NewSection",
  "NewWindow",
  "Notify",
  "OnChanged",
  "PivotTo",
  "Play",
  "SetAttribute",
  "SetCore",
  "SetValue",
  "Wait",
  "WaitForChild",
  "WorldToViewportPoint"
]);

function classifyPolyDirectInstruction(instruction) {
  const { mode, flags, b, c } = instruction;
  if (mode === 1 && flags === 2) return KNOWN_GLOBALS.has(b) ? "getglobal" : "loadk";
  if (mode === 0 && flags === 4 && typeof c === "string") return METHOD_NAMES.has(c) ? "self_k" : "gettable_k";
  if (mode === 0 && flags === 4 && c !== null && c !== undefined) return "gettable_k";
  if (mode === 0 && flags === 2 && b !== null && b !== undefined) return "settable_kc";
  if (mode === 0 && flags === 6 && b !== null && b !== undefined) return "settable_k_const";
  if (mode === 0 && flags === 0 && c === 0) return b === 0 ? "call_var_results" : "call_b_multiret";
  if (mode === 0 && flags === 0 && c === 1) return b === 0 ? "call_var_noret" : typeof b === "number" && b < instruction.a + 1 ? "call_count_noret" : "call_b_noret";
  if (mode === 0 && flags === 0 && c === 2) return b === 0 ? "call_var_assign1" : typeof b === "number" && b < instruction.a + 1 ? "call_count_assign1" : "call_b_assign1";
  return null;
}

function collectInstructionList(proto, out = []) {
  out.push(...proto.instructions.filter((instruction) => !instruction.skipped));
  for (const child of proto.protos) collectInstructionList(child, out);
  return out;
}

function hasDirectOperandShape(instruction) {
  if (instruction.mode === 1 && instruction.flags === 2) return true;
  return instruction.mode === 0 && [2, 4, 6].includes(instruction.flags);
}

function looksLikeCatalogTableVm(proto) {
  if (proto.protos.length !== 0) return false;
  if (!hasAllConstants(proto.constants, ["id", "lastupdated", "name", "price"])) return false;

  const loadCount = proto.instructions.filter((instruction) => instruction.op === 15 && instruction.mode === 1 && instruction.flags === 2).length;
  const fieldSetCount = proto.instructions.filter((instruction) => instruction.op === 16 && instruction.mode === 0 && instruction.flags === 2).length;
  const inlineSetCount = proto.instructions.filter((instruction) => instruction.op === 2 && instruction.mode === 0 && instruction.flags === 6).length;
  return loadCount + inlineSetCount > 100 && fieldSetCount + inlineSetCount > 100;
}

function buildCatalogTableProfile(proto) {
  if (!looksLikeCatalogTableVm(proto)) return null;
  return {
    semantics: {
      0: "setlist",
      2: "settable_k_const",
      4: "return_nil",
      6: "setlist",
      12: "newtable",
      13: "return_one",
      15: "loadk",
      16: "settable_kc"
    },
    upvalueMarkerOps: new Set(),
    nestedWrapper: false,
    genericDirect: true,
    allowLowConfidenceLift: true
  };
}

function collectOpcodeStats(proto) {
  const opcodes = new Set();
  let instructionCount = 0;
  let highestOpcode = -Infinity;

  (function visit(current) {
    for (const instruction of current.instructions) {
      if (instruction.skipped) continue;
      instructionCount += 1;
      opcodes.add(instruction.op);
      if (typeof instruction.op === "number") highestOpcode = Math.max(highestOpcode, instruction.op);
    }
    for (const child of current.protos) visit(child);
  })(proto);

  return {
    instructionCount,
    distinctOpcodes: opcodes.size,
    highestOpcode
  };
}

function inferGenericClosureOps(proto) {
  const candidates = new Map();

  (function visit(current) {
    for (const instruction of current.instructions) {
      if (instruction.skipped || instruction.mode !== 3 || instruction.flags !== 0) continue;

      const candidate = candidates.get(instruction.op) ?? { total: 0, validChild: 0 };
      candidate.total += 1;
      if (
        Number.isInteger(instruction.b) &&
        instruction.b >= 0 &&
        instruction.b < current.protos.length &&
        Number.isInteger(instruction.c) &&
        instruction.c >= 0
      ) {
        candidate.validChild += 1;
      }
      candidates.set(instruction.op, candidate);
    }

    for (const child of current.protos) visit(child);
  })(proto);

  return new Set(
    [...candidates]
      .filter(([, candidate]) => candidate.total >= 2 && candidate.validChild === candidate.total)
      .map(([op]) => op)
  );
}

function classifyGenericDirectInstruction(instruction, proto, closureOps = new Set()) {
  const { mode, flags, b, c } = instruction;

  if (mode === 1 && flags === 2) return KNOWN_GLOBALS.has(b) ? "getglobal" : "loadk";
  if (mode === 0 && flags === 4 && typeof c === "string") return METHOD_NAMES.has(c) ? "self_k" : "gettable_k";
  if (mode === 0 && flags === 2 && b !== null && b !== undefined) return "settable_kc";
  if (mode === 0 && flags === 6 && b !== null && b !== undefined) return "settable_k_const";
  if (mode === 3 && flags === 0 && closureOps.has(instruction.op) && typeof b === "number" && proto?.protos?.[b]) {
    return "closure";
  }
  if (mode === 0 && flags === 0 && c === 0) return b === 0 ? "call_var_results" : "call_b_multiret";
  if (mode === 0 && flags === 0 && c === 1) return b === 0 ? "call_var_noret" : typeof b === "number" && b < instruction.a + 1 ? "call_count_noret" : "call_b_noret";
  if (mode === 0 && flags === 0 && c === 2) return b === 0 ? "call_var_assign1" : typeof b === "number" && b < instruction.a + 1 ? "call_count_assign1" : "call_b_assign1";

  return null;
}

function buildGenericDirectProfile(proto) {
  const catalogProfile = buildCatalogTableProfile(proto);
  if (catalogProfile) return catalogProfile;

  const instructions = collectInstructionList(proto);
  if (instructions.length < 20) return null;

  const directShapeCount = instructions.filter(hasDirectOperandShape).length;
  const stringLoadCount = instructions.filter((instruction) => instruction.mode === 1 && instruction.flags === 2 && typeof instruction.b === "string").length;
  const propertyAccessCount = instructions.filter((instruction) => instruction.mode === 0 && instruction.flags === 4 && typeof instruction.c === "string").length;
  const propertyWriteCount = instructions.filter((instruction) => instruction.mode === 0 && [2, 6].includes(instruction.flags) && typeof instruction.b === "string").length;
  const directRatio = directShapeCount / instructions.length;

  if (stringLoadCount < 6 || propertyAccessCount + propertyWriteCount < 6 || directRatio < 0.18) return null;

  const closureOps = inferGenericClosureOps(proto);
  const opcodeStats = collectOpcodeStats(proto);
  const preserveVmIr =
    opcodeStats.instructionCount >= 1000 &&
    opcodeStats.highestOpcode > 128 &&
    opcodeStats.distinctOpcodes > 96;

  return {
    semantics: {},
    kindForInstruction: (instruction, currentProto) => {
      return classifyGenericDirectInstruction(instruction, currentProto, closureOps);
    },
    upvalueMarkerOps: new Set(),
    nestedWrapper: false,
    genericDirect: true,
    suppressUnknown: false,
    preferDispatcherAnalysis: true,
    preserveVmIr,
    opcodeStats
  };
}

const XOR_DECODER_SEMANTIC_SEQUENCE = [
  "newtable",
  "loadk",
  "len",
  "loadk",
  "forprep",
  "getupvalue",
  "move",
  "getupvalue",
  "getupvalue",
  "getupvalue",
  "getupvalue",
  "move",
  "move",
  "add_k",
  "call_b_multiret",
  "call_var_assign1",
  "getupvalue",
  "getupvalue",
  "move",
  "len",
  "mod",
  "add_kr",
  "len",
  "mod",
  "add_kr",
  "add_k",
  "call_b_multiret",
  "call_var_results",
  "call_var_assign1",
  "mod_k",
  "call1_multiret",
  "call_var_noret",
  "forloop",
  "getupvalue",
  "move",
  "return_call_b",
  "return_varargs",
  "return_nil"
];

function maxOpcode(proto) {
  let max = -Infinity;
  for (const instruction of proto.instructions) {
    if (!instruction.skipped && typeof instruction.op === "number") max = Math.max(max, instruction.op);
  }
  for (const child of proto.protos) max = Math.max(max, maxOpcode(child));
  return max;
}

function countInstructions(proto) {
  let count = proto.instructions.length;
  for (const child of proto.protos) count += countInstructions(child);
  return count;
}

function inferSemanticMap(proto) {
  return inferVmProfile(proto).semantics;
}

function hasAllConstants(constants, values) {
  return values.every((value) => constants.includes(value));
}

function firstInstructionWithValue(proto, slot, value) {
  return proto.instructions.find((instruction) => !instruction.skipped && instruction[slot] === value);
}

function profileMatchesConstantLoad(proto, semantics, value, kind) {
  const instruction = firstInstructionWithValue(proto, "b", value);
  return instruction && semantics[instruction.op] === kind;
}

function addSemantic(semantics, op, kind, force = false) {
  if (typeof op !== "number") return;
  if (force || !semantics[op]) semantics[op] = kind;
}

function addOpcodeSemantic(semantics, instruction, kind, force = false) {
  if (instruction?.op === 0) return;
  addSemantic(semantics, instruction?.op, kind, force);
}

function buildXorWrapperProfile(proto) {
  const decoder = proto.protos.find((child) => isLikelyXorDecoderProto(child));
  if (!decoder) return null;

  const semantics = {};
  const upvalueMarkerOps = new Set();
  const decoderInstructions = decoder.instructions.filter((instruction) => !instruction.skipped);
  for (let i = 0; i < Math.min(decoderInstructions.length, XOR_DECODER_SEMANTIC_SEQUENCE.length); i += 1) {
    addOpcodeSemantic(semantics, decoderInstructions[i], XOR_DECODER_SEMANTIC_SEQUENCE[i]);
  }

  const root = proto.instructions.filter((instruction) => !instruction.skipped);
  for (const instruction of root) {
    if (["string", "bit32", "bit", "table"].includes(instruction.b)) addOpcodeSemantic(semantics, instruction, "getglobal", true);
    if (["char", "byte", "sub", "bxor", "concat", "insert"].includes(instruction.c)) {
      addOpcodeSemantic(semantics, instruction, "gettable_k", true);
    }
  }

  const bit32Index = root.findIndex((instruction) => instruction.b === "bit32");
  if (bit32Index >= 0) {
    addOpcodeSemantic(semantics, root[bit32Index + 1], "testset_truthy", true);
    addOpcodeSemantic(semantics, root[bit32Index + 2], "jmp", true);
  }

  for (let i = 0; i < root.length; i += 1) {
    const instruction = root[i];
    if (typeof instruction.b === "number" && proto.protos[instruction.b] && instruction.mode === 3) {
      addOpcodeSemantic(semantics, instruction, "closure", true);
      const count = instruction.c ?? 0;
      for (let j = 1; j <= count; j += 1) {
        const marker = root[i + j];
        if (!marker) continue;
        addOpcodeSemantic(semantics, marker, "upvalue_marker", true);
        upvalueMarkerOps.add(marker.op);
      }
      i += count;
    }
  }

  for (let i = 3; i < root.length; i += 1) {
    const move = root[i - 3];
    const data = root[i - 2];
    const key = root[i - 1];
    const call = root[i];
    const store = root[i + 1];
    if (
      semantics[move?.op] === "move" &&
      semantics[data?.op] === "loadk" &&
      semantics[key?.op] === "loadk" &&
      typeof data.b === "string" &&
      typeof key.b === "string" &&
      call.a === move.a &&
      call.c === 2
    ) {
      addOpcodeSemantic(semantics, call, "call_b_assign1", true);
      if (store) addOpcodeSemantic(semantics, store, "settable_kr", true);
    }
  }

  const methodNames = new Set([
    "AddButton",
    "AddDropdown",
    "AddTextbox",
    "AddToggle",
    "Connect",
    "CreateSection",
    "CreateTab",
    "CreateWindow",
    "FireServer",
    "FindFirstChild",
    "GetPlayers",
    "GetService",
    "PivotTo",
    "SetCore",
    "WaitForChild",
    "WorldToViewportPoint"
  ]);
  const allInstructions = [];
  (function collectInstructions(current) {
    allInstructions.push(...current.instructions.filter((instruction) => !instruction.skipped));
    for (const child of current.protos) collectInstructions(child);
  })(proto);

  for (const instruction of allInstructions) {
    if (typeof instruction.c === "string" && methodNames.has(instruction.c)) {
      addOpcodeSemantic(semantics, instruction, "self_k");
    }
  }

  for (const instruction of allInstructions) {
    if (semantics[instruction.op]) continue;
    if (instruction.mode === 0 && instruction.flags === 0 && instruction.c === 1 && typeof instruction.b === "number") {
      addOpcodeSemantic(semantics, instruction, instruction.b < instruction.a + 1 ? "call_count_noret" : "call_b_noret");
    } else if (
      instruction.mode === 0 &&
      bitField(instruction.flags, 3, 3) === 1 &&
      bitField(instruction.flags, 2, 2) === 0 &&
      typeof instruction.b === "number"
    ) {
      addOpcodeSemantic(semantics, instruction, "settable_rk");
    } else if (
      instruction.mode === 0 &&
      instruction.flags === 0 &&
      typeof instruction.b === "number" &&
      typeof instruction.c === "number" &&
      instruction.a !== 0
    ) {
      const previous = allInstructions.find((candidate) => candidate.pc === instruction.pc - 1);
      if (previous && bitField(previous.flags ?? 0, 3, 3) === 1) addOpcodeSemantic(semantics, instruction, "settable_r");
    }
  }

  return {
    semantics,
    kindForInstruction: (instruction, currentProto) => {
      if (instruction.mode === 3 && typeof instruction.b === "number" && currentProto?.protos?.[instruction.b]) return "closure";
      if (instruction.op === 0 || hasDirectOperandShape(instruction)) return classifyGenericDirectInstruction(instruction, currentProto);
      return null;
    },
    upvalueMarkerOps,
    nestedWrapper: true,
    allowLowConfidenceLift: true
  };
}

function inferVmProfile(proto) {
  const constants = collectConstants(proto);
  const max = maxOpcode(proto);
  const looksLikeFullChaoticVm = constants.includes("GetService") && constants.includes("Players") && max > 100;
  const looksLikeNestedChaoticEvil = hasAllConstants(constants, [
    "char",
    "byte",
    "sub",
    "bxor",
    "concat",
    "insert",
    "match",
    "tonumber",
    "pcall"
  ]) && max > 130;
  const looksLikeAnyXorWrapper = hasAllConstants(constants, [
    "char",
    "byte",
    "sub",
    "bxor",
    "concat",
    "insert"
  ]) && proto.protos.some((child) => isLikelyXorDecoderProto(child));
  const looksLikeChatPunishPayload = constants.includes("SayMessageRequest") && max <= 50;
  const looksLikeInlineXorWrapper = hasAllConstants(constants, [
    "char",
    "byte",
    "sub",
    "bxor",
    "concat",
    "insert",
    "print"
  ]) && max <= 60;
  const looksLikeRemoteSample = hasAllConstants(constants, ["NoobiesGot", "FireServer", "ReplicatedStorage"]) && max <= 20;
  const looksLikeUiSample = hasAllConstants(constants, ["GetObjects", "CreateWindow", "Nebulua"]) && max <= 130;
  const looksLikeBeeDirectVm = hasAllConstants(constants, [
    "beeconloaded",
    "APIToken",
    "VigenereKey",
    "TrueEndpoint",
    "FalseEndpoint"
  ]) && max <= 100;
  const looksLikeMm2DirectVm = hasAllConstants(constants, ["webHook", "build_games5", "CreateEmbed", "SendWebhook"]) && max <= 100;
  const looksLikeKeyGuiVm = hasAllConstants(constants, ["Legends Handles Key System", "Enter Key...", "Correct Key!"]) && max <= 70;
  const looksLikeSmallUiVm = hasAllConstants(constants, ["GET LOTS OF MONEY", "LOOP MONEY (IRREVERSIBLE)", "TELEPORT TO END (WORLD 1 ONLY)"]) && max <= 70;
  const looksLikePlayerUiVm = hasAllConstants(constants, ["NewWindow", "spawn players", "CreateToggle", "cpy yt"]) && max <= 60;

  if (looksLikeRemoteSample) {
    return {
      semantics: VM_SAMPLES_REMOTE_VM_SEMANTICS,
      upvalueMarkerOps: new Set(),
      nestedWrapper: false
    };
  }

  if (looksLikeUiSample) {
    return {
      semantics: VM_SAMPLES_UI_VM_SEMANTICS,
      upvalueMarkerOps: new Set([3]),
      nestedWrapper: false
    };
  }

  if (looksLikeBeeDirectVm) {
    return {
      semantics: VM_SAMPLES_BEE_DIRECT_VM_SEMANTICS,
      upvalueMarkerOps: new Set(),
      nestedWrapper: false
    };
  }

  if (looksLikeMm2DirectVm) {
    return {
      semantics: VM_SAMPLES_MM2_DIRECT_VM_SEMANTICS,
      upvalueMarkerOps: new Set(),
      nestedWrapper: false
    };
  }

  if (looksLikeKeyGuiVm) {
    return {
      semantics: VM_SAMPLES_KEY_GUI_VM_SEMANTICS,
      kindForInstruction: (instruction) => instruction.op === 0 ? classifyPolyDirectInstruction(instruction) : null,
      upvalueMarkerOps: new Set(),
      nestedWrapper: false
    };
  }

  if (looksLikeSmallUiVm) {
    return {
      semantics: VM_SAMPLES_SMALL_UI_VM_SEMANTICS,
      kindForInstruction: (instruction) => instruction.op === 0 ? classifyPolyDirectInstruction(instruction) : null,
      upvalueMarkerOps: new Set(),
      nestedWrapper: false
    };
  }

  if (looksLikePlayerUiVm) {
    return {
      semantics: VM_SAMPLES_PLAYER_UI_VM_SEMANTICS,
      kindForInstruction: (instruction) => instruction.op === 0 ? classifyPolyDirectInstruction(instruction) : null,
      upvalueMarkerOps: new Set(),
      nestedWrapper: false
    };
  }

  if (looksLikeNestedChaoticEvil && profileMatchesConstantLoad(proto, CHAOTIC_EVIL_LARGE_VM_SEMANTICS, "string", "getglobal")) {
    return {
      semantics: CHAOTIC_EVIL_LARGE_VM_SEMANTICS,
      upvalueMarkerOps: new Set([80]),
      nestedWrapper: true
    };
  }

  if (looksLikeAnyXorWrapper) {
    const dynamicProfile = buildXorWrapperProfile(proto);
    if (dynamicProfile && Object.keys(dynamicProfile.semantics).length > 0) return dynamicProfile;
  }

  if (looksLikeChatPunishPayload) {
    return {
      semantics: CHAOTIC_EVIL_CHAT_VM_SEMANTICS,
      upvalueMarkerOps: new Set([38]),
      nestedWrapper: false
    };
  }

  if (looksLikeInlineXorWrapper) {
    const usesAltInlineMap = proto.instructions[0]?.op !== 34;
    return {
      semantics: usesAltInlineMap ? CHAOTIC_EVIL_INLINE_XOR_ALT_VM_SEMANTICS : CHAOTIC_EVIL_INLINE_XOR_VM_SEMANTICS,
      upvalueMarkerOps: new Set(usesAltInlineMap ? [9] : [39]),
      nestedWrapper: false
    };
  }

  if (looksLikeFullChaoticVm && profileMatchesConstantLoad(proto, SAMPLE_VM_SEMANTICS, "game", "getglobal")) {
    return {
      semantics: SAMPLE_VM_SEMANTICS,
      upvalueMarkerOps: new Set([14]),
      nestedWrapper: false
    };
  }

  const genericDirectProfile = buildGenericDirectProfile(proto);
  if (genericDirectProfile) return genericDirectProfile;

  return {
    semantics: {},
    upvalueMarkerOps: new Set(),
    nestedWrapper: false
  };
}

function registerName(index) {
  if (typeof index !== "number") return `r[${luaValue(index)}]`;
  return `r[${index}]`;
}

function upvalueName(index) {
  if (typeof index !== "number") return `u[${luaValue(index)}]`;
  return `u[${index}]`;
}

function label(pc) {
  return `L${pc}`;
}

function rangeArgs(start, endExpression) {
  return `unpack(r, ${start}, ${endExpression})`;
}

function jumpTarget(instruction) {
  return typeof instruction.b === "number" ? instruction.b + 1 : instruction.b;
}

function instructionFieldValue(instruction, field) {
  if (field === 2) return instruction.a;
  if (field === 3) return instruction.b;
  if (field === 4) return instruction.c;
  return null;
}

function renderBranchOperand(operand, instruction) {
  const value = instructionFieldValue(instruction, operand.field);
  return operand.type === "register" ? registerName(value) : luaValue(value);
}

function renderBranchCondition(branch, instruction) {
  const left = renderBranchOperand(branch.left, instruction);
  if (branch.operator === "truthy") return left;
  if (branch.operator === "falsy") return `not ${left}`;
  return `${left} ${branch.operator} ${renderBranchOperand(branch.right, instruction)}`;
}

function branchActionTarget(action, instruction) {
  return action === "advance" ? instruction.pc + 2 : jumpTarget(instruction);
}

function emitInstruction(instruction, semantics, proto) {
  if (instruction.skipped) return [`-- skipped descriptor ${instruction.descriptor}`];

  const kind = instruction.kind ?? semantics[instruction.op];
  const a = instruction.a;
  const b = instruction.b;
  const c = instruction.c;

  switch (kind) {
    case "loadnil":
      return [`for i = ${a}, ${b} do r[i] = nil end`];
    case "getglobal":
      return [`${registerName(a)} = env[${luaValue(b)}]`];
    case "setglobal":
      return [`env[${luaValue(b)}] = ${registerName(a)}`];
    case "getupvalue":
      return [`${registerName(a)} = get_upvalue(${luaValue(b)})`];
    case "setupvalue":
      return [`set_upvalue(${luaValue(b)}, ${registerName(a)})`];
    case "loadk":
      return [`${registerName(a)} = ${luaValue(b)}`];
    case "loadbool":
    case "loadbool_skip":
      return [`${registerName(a)} = ${b ? "true" : "false"}`];
    case "move":
      return [`${registerName(a)} = ${registerName(b)}`];
    case "newtable":
      return [`${registerName(a)} = {}`];
    case "gettable_k":
      return [`${registerName(a)} = ${registerName(b)}[${luaValue(c)}]`];
    case "gettable_r":
      return [`${registerName(a)} = ${registerName(b)}[${registerName(c)}]`];
    case "self_k":
      return [
        `${registerName(a + 1)} = ${registerName(b)}`,
        `${registerName(a)} = ${registerName(b)}[${luaValue(c)}]`
      ];
    case "self_r":
      return [
        `${registerName(a + 1)} = ${registerName(b)}`,
        `${registerName(a)} = ${registerName(b)}[${registerName(c)}]`
      ];
    case "settable_kc":
      return [`${registerName(a)}[${luaValue(b)}] = ${registerName(c)}`];
    case "settable_k_const":
      return [`${registerName(a)}[${luaValue(b)}] = ${luaValue(c)}`];
    case "settable_r":
      return [`${registerName(a)}[${registerName(b)}] = ${registerName(c)}`];
    case "settable_rk":
      return [`${registerName(a)}[${registerName(b)}] = ${luaValue(c)}`];
    case "settable_kr":
      return [`${registerName(a)}[${luaValue(b)}] = ${registerName(c)}`];
    case "add":
      return [`${registerName(a)} = ${registerName(b)} + ${registerName(c)}`];
    case "add_k":
      return [`${registerName(a)} = ${registerName(b)} + ${luaValue(c)}`];
    case "add_kr":
      return [`${registerName(a)} = ${luaValue(b)} + ${registerName(c)}`];
    case "sub":
      return [`${registerName(a)} = ${registerName(b)} - ${registerName(c)}`];
    case "sub_k":
      return [`${registerName(a)} = ${registerName(b)} - ${luaValue(c)}`];
    case "mul":
      return [`${registerName(a)} = ${registerName(b)} * ${registerName(c)}`];
    case "mul_k":
      return [`${registerName(a)} = ${registerName(b)} * ${luaValue(c)}`];
    case "div_k":
      return [`${registerName(a)} = ${registerName(b)} / ${luaValue(c)}`];
    case "div_kr":
      return [`${registerName(a)} = ${luaValue(b)} / ${registerName(c)}`];
    case "div":
      return [`${registerName(a)} = ${registerName(b)} / ${registerName(c)}`];
    case "div_kk":
      return [`${registerName(a)} = ${luaValue(b)} / ${luaValue(c)}`];
    case "mod":
      return [`${registerName(a)} = ${registerName(b)} % ${registerName(c)}`];
    case "mod_k":
      return [`${registerName(a)} = ${registerName(b)} % ${luaValue(c)}`];
    case "unm":
      return [`${registerName(a)} = -${registerName(b)}`];
    case "not":
      return [`${registerName(a)} = not ${registerName(b)}`];
    case "len":
      return [`${registerName(a)} = #${registerName(b)}`];
    case "concat":
      return [`do local value = ${registerName(b)}; for i = ${b + 1}, ${c} do value = value .. r[i] end; ${registerName(a)} = value end`];
    case "jmp":
      return [`goto ${label(jumpTarget(instruction))}`];
    case "branch": {
      const condition = renderBranchCondition(instruction.branch, instruction);
      const trueTarget = branchActionTarget(instruction.branch.trueAction, instruction);
      const falseTarget = branchActionTarget(instruction.branch.falseAction, instruction);
      return [`if ${condition} then goto ${label(trueTarget)} else goto ${label(falseTarget)} end`];
    }
    case "eq_k_jump":
      return [`if ${registerName(a)} == ${luaValue(c)} then goto ${label(instruction.pc + 1)} else goto ${label(b)} end`];
    case "ne_k_jump":
      return [`if ${registerName(a)} ~= ${luaValue(c)} then goto ${label(instruction.pc + 1)} else goto ${label(b)} end`];
    case "eq_reg_jump":
      return [`if ${registerName(a)} == ${registerName(c)} then goto ${label(instruction.pc + 1)} else goto ${label(b)} end`];
    case "ne_reg_jump":
      return [`if ${registerName(a)} ~= ${registerName(c)} then goto ${label(instruction.pc + 1)} else goto ${label(b)} end`];
    case "lt_reg_jump":
      return [`if ${a} < ${registerName(c)} then goto ${label(instruction.pc + 1)} else goto ${label(b)} end`];
    case "test_truthy":
      return [`if ${registerName(a)} then goto ${label(instruction.pc + 1)} else goto ${label(b)} end`];
    case "testset_truthy":
      return [`if ${registerName(c)} then ${registerName(a)} = ${registerName(c)}; goto ${label(jumpTarget(instruction))} else goto ${label(instruction.pc + 2)} end`];
    case "testset_falsy":
      return [`if ${registerName(c)} then goto ${label(instruction.pc + 2)} else ${registerName(a)} = ${registerName(c)}; goto ${label(jumpTarget(instruction))} end`];
    case "call0_noret":
      return [`${registerName(a)}()`];
    case "call1_noret":
      return [`${registerName(a)}(${registerName(a + 1)})`];
    case "call_b_noret":
      return [`${registerName(a)}(${rangeArgs(a + 1, b)})`];
    case "call_count_noret":
      return [`${registerName(a)}(${rangeArgs(a + 1, a + b - 1)})`];
    case "call_var_noret":
      return [`${registerName(a)}(${rangeArgs(a + 1, "top")})`];
    case "call0_assign1":
      return [`${registerName(a)} = ${registerName(a)}()`];
    case "call1_assign1":
      return [`${registerName(a)} = ${registerName(a)}(${registerName(a + 1)})`];
    case "call_b_assign1":
      return [`${registerName(a)} = ${registerName(a)}(${rangeArgs(a + 1, b)})`];
    case "call_count_assign1":
      return [`${registerName(a)} = ${registerName(a)}(${rangeArgs(a + 1, a + b - 1)})`];
    case "call_var_assign1":
      return [`${registerName(a)} = ${registerName(a)}(${rangeArgs(a + 1, "top")})`];
    case "call1_multiret":
      return [
        `do local out = pack(${registerName(a)}(${registerName(a + 1)})); top = ${a} + out.n - 1; for i = 1, out.n do r[${a} + i - 1] = out[i] end end`
      ];
    case "call_b_multiret":
      return [
        `do local out = pack(${registerName(a)}(${rangeArgs(a + 1, b)})); top = ${a} + out.n - 1; for i = 1, out.n do r[${a} + i - 1] = out[i] end end`
      ];
    case "call0_multiret":
      return [
        `do local out = pack(${registerName(a)}()); top = ${a} + out.n - 1; for i = 1, out.n do r[${a} + i - 1] = out[i] end end`
      ];
    case "call_b_results":
      return [
        `do local out = {${registerName(a)}(${rangeArgs(a + 1, b)})}; for i = 0, ${c - a} do r[${a} + i] = out[i + 1] end end`
      ];
    case "call1_results":
      return [
        `do local out = {${registerName(a)}(${registerName(a + 1)})}; for i = 0, ${c - a} do r[${a} + i] = out[i + 1] end end`
      ];
    case "call_var_results":
      return [
        `do local out = {${registerName(a)}(${rangeArgs(a + 1, "top")})}; for i = 0, ${c - a} do r[${a} + i] = out[i + 1] end end`
      ];
    case "return_nil":
      return ["do return end"];
    case "return_one":
      return [`do return ${registerName(a)} end`];
    case "return_call0":
      return [`do return ${registerName(a)}() end`];
    case "return_call_b":
      return [`do return ${registerName(a)}(${rangeArgs(a + 1, b)}) end`];
    case "return_varargs":
      return [`do return ${rangeArgs(a, "top")} end`];
    case "return_range":
      return [`do return ${rangeArgs(a, a + b)} end`];
    case "append_varargs":
      return [`for i = ${a + 1}, top do table.insert(${registerName(a)}, r[i]) end`];
    case "setlist":
      return [`for i = 1, ${b} do ${registerName(a)}[i] = r[${a} + i] end`];
    case "setlist_range":
      return [`for i = ${a + 1}, ${b} do table.insert(${registerName(a)}, r[i]) end`];
    case "closure":
      if (typeof b !== "number") return [`-- closure target unavailable: child=${formatOperand(b)}`];
      return [
        `${registerName(a)} = protos[${luaValue(`${proto.path.replace(/\./g, "_")}_${b}`)}](env, {`,
        ...(instruction.captures ?? []).map((capture, index) => {
          const value = capture.source === "register"
            ? `capture_register(${capture.index})`
            : `capture_upvalue(${capture.index})`;
          return `  [${index}] = ${value},`;
        }),
        "})"
      ];
    case "close":
      return [`close_upvalues(${a})`];
    case "forprep":
      return [
        `do local index = ${registerName(a)}; local limit = ${registerName(a + 1)}; local step = ${registerName(a + 2)}; if (step > 0 and index > limit) or (step <= 0 and index < limit) then goto ${label(jumpTarget(instruction))} else ${registerName(a + 3)} = index end end`
      ];
    case "forloop":
      return [
        `do local step = ${registerName(a + 2)}; local index = ${registerName(a)} + step; ${registerName(a)} = index; if (step > 0 and index <= ${registerName(a + 1)}) or (step <= 0 and index >= ${registerName(a + 1)}) then ${registerName(a + 3)} = index; goto ${label(jumpTarget(instruction))} end end`
      ];
    case "tforloop":
      return [
        `do local out = {${registerName(a)}(${registerName(a + 1)}, ${registerName(a + 2)})}; for i = 1, ${c} do r[${a + 2} + i] = out[i] end; if out[1] then ${registerName(a + 2)} = out[1]; goto ${label(jumpTarget(instruction))} else goto ${label(instruction.pc + 2)} end end`
      ];
    case "skipped":
      return [`-- skipped descriptor ${instruction.descriptor}`];
    default:
      return [`-- vm ${formatInstruction(instruction)}`];
  }
}

function emitRegisterProto(proto, semantics, lines) {
  for (const child of proto.protos) emitRegisterProto(child, semantics, lines);

  const functionName = proto.path.replace(/\./g, "_");
  const existingLabels = new Set(proto.instructions.map((instruction) => instruction.pc));
  const extraLabels = new Set([0]);

  for (const instruction of proto.instructions) {
    const kind = instruction.kind ?? semantics[instruction.op];
    const targets = [];
    if (["jmp", "forprep", "forloop", "tforloop", "testset_truthy", "testset_falsy"].includes(kind)) {
      targets.push(jumpTarget(instruction));
    } else if (kind === "branch") {
      targets.push(
        branchActionTarget(instruction.branch.trueAction, instruction),
        branchActionTarget(instruction.branch.falseAction, instruction)
      );
    } else if (
      [
        "eq_k_jump",
        "ne_k_jump",
        "eq_reg_jump",
        "ne_reg_jump",
        "lt_reg_jump",
        "test_truthy"
      ].includes(kind)
    ) {
      targets.push(instruction.b, instruction.pc + 1);
    }

    for (const target of targets) {
      if (typeof target === "number" && !existingLabels.has(target)) extraLabels.add(target);
    }
  }

  lines.push(`protos[${luaValue(functionName)}] = function(env, u)`);
  lines.push("  env = env or _ENV");
  lines.push("  u = u or {}");
  lines.push("  return function(...)");
  lines.push("    local r = {}");
  lines.push("    local args = {...}");
  lines.push("    local argc = select('#', ...) - 1");
  lines.push("    local varargs = {}");
  lines.push("    local top = -1");
  lines.push("    local open_upvalues = {}");
  lines.push("    local function pack(...) return { n = select('#', ...), ... } end");
  lines.push("    local function capture_register(index)");
  lines.push("      local cell = open_upvalues[index]");
  lines.push("      if cell == nil then");
  lines.push("        cell = {}");
  lines.push("        cell.get = function() return r[index] end");
  lines.push("        cell.set = function(value) r[index] = value end");
  lines.push("        open_upvalues[index] = cell");
  lines.push("      end");
  lines.push("      return cell");
  lines.push("    end");
  lines.push("    local function capture_upvalue(index)");
  lines.push("      if u[index] == nil then u[index] = new_closed_cell(nil) end");
  lines.push("      return u[index]");
  lines.push("    end");
  lines.push("    local function get_upvalue(index) return capture_upvalue(index).get() end");
  lines.push("    local function set_upvalue(index, value) capture_upvalue(index).set(value) end");
  lines.push("    local function close_upvalues(first)");
  lines.push("      for index, cell in pairs(open_upvalues) do");
  lines.push("        if index >= first then");
  lines.push("          local value = cell.get()");
  lines.push("          local closed = value");
  lines.push("          cell.get = function() return closed end");
  lines.push("          cell.set = function(next_value) closed = next_value end");
  lines.push("          open_upvalues[index] = nil");
  lines.push("        end");
  lines.push("      end");
  lines.push("    end");
  lines.push("    for i = 0, argc do");
  lines.push(`      if i >= ${proto.parameterCount} then varargs[i - ${proto.parameterCount}] = args[i + 1] else r[i] = args[i + 1] end`);
  lines.push("    end");
  lines.push("");
  if (extraLabels.has(0)) lines.push(`    ::${label(0)}::`);

  for (const instruction of proto.instructions) {
    lines.push(`    ::${label(instruction.pc)}::`);
    for (const emitted of emitInstruction(instruction, semantics, proto)) {
      lines.push(`    ${emitted}`);
    }
  }

  for (const extra of [...extraLabels].filter((value) => value !== 0).sort((a, b) => a - b)) {
    lines.push(`    ::${label(extra)}::`);
    lines.push("    do end");
  }

  lines.push("  end");
  lines.push("end");
  lines.push("");
}

function isConstOperand(instruction, slot) {
  const bit = slot === "a" ? 1 : slot === "b" ? 2 : 3;
  return bitField(instruction.flags ?? 0, bit, bit) === 1;
}

function isIdentifier(value) {
  return typeof value === "string" &&
    /^[A-Za-z_][A-Za-z0-9_]*$/.test(value) &&
    !LUA_KEYWORDS.has(value);
}

const LUA_KEYWORDS = new Set([
  "and",
  "break",
  "do",
  "else",
  "elseif",
  "end",
  "false",
  "for",
  "function",
  "goto",
  "if",
  "in",
  "local",
  "nil",
  "not",
  "or",
  "repeat",
  "return",
  "then",
  "true",
  "until",
  "while"
]);

function isDirectPrefixExpression(expr) {
  const trimmed = expr.trim();
  const root = /^[A-Za-z_][A-Za-z0-9_]*/.exec(trimmed)?.[0];
  if (!root || LUA_KEYWORDS.has(root)) return false;
  return /^[A-Za-z_][A-Za-z0-9_]*(?:(?:\.[A-Za-z_][A-Za-z0-9_]*)|(?:\[[^\n]+\]))*$/.test(trimmed);
}

function propertyAccess(base, key) {
  const target = prefixExpr(base);
  if (isIdentifier(key)) return `${target}.${key}`;
  return `${target}[${luaValue(key)}]`;
}

function prefixExpr(expr) {
  const text = typeof expr === "string" && expr.trim() && expr.trim() !== "()"
    ? expr
    : "nil";
  const trimmed = text.trim();
  if (!/\n/.test(text) && (isDirectPrefixExpression(trimmed) || (trimmed.startsWith("(") && trimmed.endsWith(")")))) {
    return text;
  }
  return `(${text})`;
}

function commentSource(text) {
  return String(text)
    .split("\n")
    .map((line) => `-- ${line}`)
    .join("\n");
}

function inlineCommentExpression(value, maxLength = 180) {
  const text = String(value ?? "nil").replace(/\s+/g, " ").trim() || "nil";
  return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
}

function makeExpr(expr, extra = {}) {
  return { expr, ...extra };
}

function cloneExpr(value) {
  if (!value) return null;
  return { ...value };
}

function xorLuaBinaryString(data, key) {
  if (!key || key.length === 0) return data;
  let out = "";
  for (let i = 1; i <= data.length; i += 1) {
    const dataByte = data.charCodeAt(i - 1) & 0xff;
    const keyByte = key.charCodeAt(i % key.length) & 0xff;
    out += String.fromCharCode((dataByte ^ keyByte) & 0xff);
  }
  return out;
}

function immediateExpr(value) {
  return makeExpr(luaValue(value), { constant: value });
}

function renderExpr(value, indent = "", seen = new Set()) {
  if (!value) return "nil";
  if (value.table) return renderTable(value.table, indent, seen);
  if (value.func) return renderFunction(value.func, indent);
  return typeof value.expr === "string" && value.expr.trim() ? value.expr : "nil";
}

function renderTable(table, indent = "", seen = new Set()) {
  if (table.entries.length === 0) return "{}";
  if (seen.has(table)) return "{ --[[ recursive table ]] }";
  seen.add(table);
  const childIndent = `${indent}  `;
  const lines = ["{"];
  for (const entry of table.entries) {
    const key = entry.keyExpr
      ? `[${renderExpr(entry.keyExpr, childIndent, seen)}] = `
      : entry.key === null
      ? ""
      : isIdentifier(entry.key)
        ? `${entry.key} = `
        : `[${luaValue(entry.key)}] = `;
    lines.push(`${childIndent}${key}${renderExpr(entry.value, childIndent, seen)},`);
  }
  lines.push(`${indent}}`);
  seen.delete(table);
  return lines.join("\n");
}

function renderFunction(fn, indent = "") {
  const childIndent = `${indent}  `;
  const parameters = [...fn.params, "..."];
  const lines = [`function(${parameters.join(", ")})`];
  if (fn.lines.length === 0) {
    lines.push(`${childIndent}-- empty`);
  } else {
    for (const line of fn.lines) lines.push(`${childIndent}${line}`);
  }
  lines.push(`${indent}end`);
  return lines.join("\n");
}

function renderStatement(text, indent = "") {
  return text
    .split("\n")
    .map((line, index) => index === 0 ? line : `${indent}${line}`)
    .join("\n");
}

function createLiftContext(proto, upvalues = []) {
  const regs = [];
  const decodedConstants = recoverOwnDecodedConstantMap(proto);
  const firstParamIsDecoder = proto.parameterCount > 0 &&
    decodedConstants.size >= 2 &&
    (proto.constants.includes("loadstring") || proto.constants.includes("CreateWindow"));
  for (let i = 0; i < proto.parameterCount; i += 1) {
    regs[i] = i === 0 && firstParamIsDecoder
      ? makeExpr("__luaobf_xor_decode", { decoder: "xor" })
      : makeExpr(`arg${i + 1}`);
  }
  return {
    regs,
    upvalues,
    declared: new Set(),
    lines: [],
    topEnd: -1,
    decodedConstants,
    unknownInstructions: 0
  };
}

function getReg(ctx, index) {
  return cloneExpr(ctx.regs[index]) ?? makeExpr(`v${index}`);
}

function setReg(ctx, index, value) {
  ctx.regs[index] = value;
}

function operandExpr(ctx, instruction, slot) {
  const value = instruction[slot];
  if (isConstOperand(instruction, slot)) {
    if (typeof value === "string" && ctx.decodedConstants?.has(value)) {
      const decoded = ctx.decodedConstants.get(value);
      return makeExpr(luaValue(decoded), { constant: decoded, decodedFromXor: value });
    }
    return makeExpr(luaValue(value), { constant: value });
  }
  if (typeof value === "number") return getReg(ctx, value);
  return makeExpr(luaValue(value), { constant: value });
}

function fieldKey(instruction, slot) {
  const value = instruction[slot];
  return isConstOperand(instruction, slot) || typeof value !== "number" ? value : null;
}

function lookupTableEntry(tableExpr, keyExpr) {
  if (!tableExpr?.table) return null;
  const key = keyExpr?.constant;
  if (key === undefined) return null;
  const entry = tableExpr.table.entries.find((candidate) => candidate.keyExpr === null && candidate.key === key);
  return entry ? cloneExpr(entry.value) : null;
}

function isSingleArgDecoderEcho(callee, args) {
  return callee?.decoder === "xor" && args.length === 1 && typeof args[0]?.constant === "string";
}

function isDecodedXorPair(args) {
  if (
    args.length !== 2 ||
    typeof args[0]?.decodedFromXor !== "string" ||
    typeof args[0]?.constant !== "string"
  ) {
    return false;
  }

  const key = typeof args[1]?.decodedFromXor === "string" ? args[1].decodedFromXor : args[1]?.constant;
  return typeof key === "string" && xorLuaBinaryString(args[0].decodedFromXor, key) === args[0].constant;
}

function callExpression(callee, args, indent = "") {
  if (!callee?.method && isDecodedXorPair(args)) {
    return luaValue(args[0].constant);
  }

  if (isSingleArgDecoderEcho(callee, args)) return luaValue(args[0].constant);

  if (
    callee?.decoder === "xor" &&
    typeof args[0]?.constant === "string" &&
    typeof args[1]?.constant === "string"
  ) {
    return luaValue(xorLuaBinaryString(args[0].constant, args[1].constant));
  }

  if (typeof args[0]?.constant === "string" && typeof args[1]?.constant === "string") {
    const decoded = xorLuaBinaryString(args[0].constant, args[1].constant);
    if (isMostlyText(decoded)) return luaValue(decoded);
  }

  if (callee?.method) {
    const renderedArgs = [...args];
    const base = prefixExpr(callee.base);
    if (renderExpr(renderedArgs[0]) === callee.base) renderedArgs.shift();
    return `${base}:${callee.method}(${renderedArgs.map((arg) => renderExpr(arg, indent)).join(", ")})`;
  }
  const target = renderExpr(callee, indent);
  const canCallDirectly = isDirectPrefixExpression(target);
  const wrapped = callee?.func || /\n/.test(target) || !canCallDirectly ? `(${target})` : target;
  return `${wrapped}(${args.map((arg) => renderExpr(arg, indent)).join(", ")})`;
}

function callExprValue(callee, args, indent = "") {
  if (!callee?.method && isDecodedXorPair(args)) {
    return makeExpr(luaValue(args[0].constant), { constant: args[0].constant });
  }

  if (isSingleArgDecoderEcho(callee, args)) {
    return makeExpr(luaValue(args[0].constant), { constant: args[0].constant });
  }

  if (
    callee?.decoder === "xor" &&
    typeof args[0]?.constant === "string" &&
    typeof args[1]?.constant === "string"
  ) {
    const decoded = xorLuaBinaryString(args[0].constant, args[1].constant);
    return makeExpr(luaValue(decoded), { constant: decoded });
  }
  if (typeof args[0]?.constant === "string" && typeof args[1]?.constant === "string") {
    const decoded = xorLuaBinaryString(args[0].constant, args[1].constant);
    if (isMostlyText(decoded)) return makeExpr(luaValue(decoded), { constant: decoded });
  }
  return makeExpr(callExpression(callee, args, indent));
}

function collectArgs(ctx, start, end) {
  const args = [];
  if (typeof end !== "number" || end < start) return args;
  for (let i = start; i <= end; i += 1) args.push(getReg(ctx, i));
  return args;
}

function assignSource(ctx, register, value, indent) {
  const name = `v${register}`;
  setReg(ctx, register, Object.hasOwn(value, "constant") ? cloneExpr(value) : makeExpr(name));
  const keyword = ctx.declared.has(register) ? "" : "local ";
  ctx.declared.add(register);
  ctx.lines.push(renderStatement(`${keyword}${name} = ${renderExpr(value, indent)}`, indent));
}

function emitSourceLine(ctx, line) {
  ctx.lines.push(line);
}

function isLikelyXorDecoderProto(proto) {
  return proto?.parameterCount === 2 &&
    proto.constants.includes(1) &&
    proto.constants.includes(256) &&
    countInstructions(proto) <= 80;
}

function childFunctionExpr(proto, childIndex, upvalues, profile) {
  const child = proto.protos[childIndex];
  if (!child) {
    return makeExpr(`function(...) -- missing proto ${childIndex}\nend`, {
      unknownInstructions: 1
    });
  }
  if (isLikelyXorDecoderProto(child)) return makeExpr("__luaobf_xor_decode", { decoder: "xor" });

  const lifted = liftProtoBody(child, profile, upvalues);
  return makeExpr("function", {
    unknownInstructions: lifted.unknownInstructions,
    func: {
      params: Array.from({ length: child.parameterCount }, (_, i) => `arg${i + 1}`),
      lines: lifted.lines
    }
  });
}

function captureUpvalues(ctx, proto, startIndex, count, profile) {
  const upvalues = [];
  const semantics = profile.semantics ?? profile;
  const markerOps = profile.upvalueMarkerOps ?? new Set([14]);
  for (let i = 0; i < count; i += 1) {
    const marker = proto.instructions[startIndex + i];
    if (!marker) {
      upvalues.push(makeExpr("nil"));
      continue;
    }
    const markerKind = instructionKind(profile, marker, proto);
    if ((markerOps.has(marker.op) || markerKind === "move") && typeof marker.b === "number") upvalues.push(getReg(ctx, marker.b));
    else if (markerKind === "getupvalue" && typeof marker.b === "number") upvalues.push(ctx.upvalues[marker.b] ?? makeExpr(`upvalue_${marker.b}`));
    else if (typeof marker.b === "number") upvalues.push(ctx.upvalues[marker.b] ?? makeExpr(`upvalue_${marker.b}`));
    else upvalues.push(makeExpr(luaValue(marker.b), { constant: marker.b }));
  }
  return upvalues;
}

function instructionKind(profile, instruction, proto) {
  if (profile?.kindForInstruction) {
    const classified = profile.kindForInstruction(instruction, proto);
    if (classified) return classified;
  }
  const semantics = profile?.semantics ?? profile;
  return semantics?.[instruction.op];
}

function hasLiftProfile(profile) {
  return Boolean(profile?.kindForInstruction) || Object.keys(profile?.semantics ?? {}).length > 0;
}

function hasReg(ctx, index) {
  return typeof index === "number" && Object.hasOwn(ctx.regs, index) && ctx.regs[index] !== undefined;
}

function isDirectInstruction(instruction) {
  return instruction.op === 0;
}

function isCallableExpr(value) {
  if (!value) return false;
  if (value.decoder || value.method || value.func) return true;
  return /^[A-Za-z_][A-Za-z0-9_]*(?:[.:][A-Za-z_][A-Za-z0-9_]*)*(?:\[[^\]]+\])*$/.test(value.expr ?? "");
}

function genericCallKind(instruction) {
  if (instruction.mode !== 0 || instruction.flags !== 0) return null;
  const { a, b, c } = instruction;
  if (c === 0) return b === 0 ? "call_var_results" : "call_b_multiret";
  if (c === 1) return b === 0 ? "call_var_noret" : typeof b === "number" && b < a + 1 ? "call_count_noret" : "call_b_noret";
  if (c === 2) return b === 0 ? "call_var_assign1" : typeof b === "number" && b < a + 1 ? "call_count_assign1" : "call_b_assign1";
  return null;
}

function isTableWriteKind(kind) {
  return [
    "settable",
    "settable_kc",
    "settable_k_const",
    "settable_r",
    "settable_rk",
    "settable_kr"
  ].includes(kind);
}

function refineInstructionKind(kind, instruction, ctx) {
  const { mode, flags, a, b, c } = instruction;

  if (mode === 0 && flags === 0 && (kind === null || kind === undefined || isTableWriteKind(kind))) {
    const callKind = genericCallKind(instruction);
    if (callKind && isCallableExpr(ctx.regs[a])) return callKind;
  }

  if (!isDirectInstruction(instruction)) return kind;

  if (mode === 0 && flags === 0) {
    if (ctx.regs[a]?.table && hasReg(ctx, b) && hasReg(ctx, c)) return "settable_r";
    if (typeof c === "number" && c >= 3 && b === 0) return "newtable";
    if (c === 2 && b === 0 && !hasReg(ctx, a)) return "newtable";
    if (c === 0 && ctx.regs[b]?.decoder && !isCallableExpr(ctx.regs[a])) return "move";
    if (c === 0 && !hasReg(ctx, a) && hasReg(ctx, b)) return "move";
    if (c === 0 && b === 0 && hasReg(ctx, a)) return "call_var_results";
    if (c === 1 && b === 0) return "call_var_noret";
    if (c === 2 && b === 0) return hasReg(ctx, a) ? "call_var_assign1" : "newtable";
  }

  if (mode === 0 && flags === 4 && ctx.regs[a]?.table) {
    return "settable_k_const";
  }

  return kind;
}

function controlFlowComment(kind, instruction, ctx) {
  const { pc, a, b, c } = instruction;
  const regA = inlineCommentExpression(renderExpr(getReg(ctx, a)));
  const regC = inlineCommentExpression(renderExpr(getReg(ctx, c)));
  const target = typeof b === "number" ? `pc ${b}` : formatOperand(b);

  switch (kind) {
    case "jmp":
      return `-- control pc ${pc}: jump to ${target}`;
    case "forprep":
      return `-- control pc ${pc}: prepare numeric for at v${a}, jump to ${target}`;
    case "forloop":
      return `-- control pc ${pc}: advance numeric for at v${a}, loop to ${target}`;
    case "tforloop":
      return `-- control pc ${pc}: advance generic for at v${a}, loop to ${target}`;
    case "test_truthy":
      return `-- control pc ${pc}: if ${regA} is falsy then jump to ${target}`;
    case "test_falsy":
      return `-- control pc ${pc}: if ${regA} is truthy then jump to ${target}`;
    case "testset_truthy":
      return `-- control pc ${pc}: test ${regC}; assign v${a} and jump to ${target} on truthy`;
    case "testset_falsy":
      return `-- control pc ${pc}: test ${regC}; assign v${a} and jump to ${target} on falsy`;
    case "eq_k_jump":
      return `-- control pc ${pc}: if ${regA} ~= ${luaValue(c)} then jump to ${target}`;
    case "eq_kreg_jump":
      return `-- control pc ${pc}: compare ${luaValue(a)} == ${regC}, alternate target ${target}`;
    case "ne_k_jump":
      return `-- control pc ${pc}: if ${regA} == ${luaValue(c)} then jump to ${target}`;
    case "eq_reg_jump":
      return `-- control pc ${pc}: if ${regA} ~= ${regC} then jump to ${target}`;
    case "ne_reg_jump":
      return `-- control pc ${pc}: if ${regA} == ${regC} then jump to ${target}`;
    case "lt_reg_jump":
      return `-- control pc ${pc}: compare ${regA} < ${regC}, alternate target ${target}`;
    case "lt_kreg_jump":
      return `-- control pc ${pc}: compare ${luaValue(a)} < ${regC}, alternate target ${target}`;
    case "le_reg_jump":
      return `-- control pc ${pc}: compare ${regA} <= ${regC}, alternate target ${target}`;
    case "le_kreg_jump":
      return `-- control pc ${pc}: compare ${luaValue(a)} <= ${regC}, alternate target ${target}`;
    default:
      return null;
  }
}

function liftProtoBody(proto, profile, upvalues = []) {
  const ctx = createLiftContext(proto, upvalues);

  for (let index = 0; index < proto.instructions.length; index += 1) {
    const instruction = proto.instructions[index];
    if (instruction.skipped) continue;
    let kind = instructionKind(profile, instruction, proto);
    kind = refineInstructionKind(kind, instruction, ctx);
    const a = instruction.a;
    const b = instruction.b;
    const c = instruction.c;

    switch (kind) {
      case "getglobal":
        setReg(ctx, a, makeExpr(isIdentifier(b) ? b : `_ENV[${luaValue(b)}]`));
        break;
      case "setglobal":
        emitSourceLine(ctx, `${isIdentifier(b) ? b : `_ENV[${luaValue(b)}]`} = ${renderExpr(getReg(ctx, a))}`);
        break;
      case "getupvalue":
        setReg(ctx, a, cloneExpr(ctx.upvalues[b]) ?? makeExpr(`upvalue_${b}`));
        break;
      case "setupvalue":
        ctx.upvalues[b] = getReg(ctx, a);
        break;
      case "loadk":
        setReg(ctx, a, operandExpr(ctx, instruction, "b"));
        break;
      case "loadbool":
      case "loadbool_skip":
        setReg(ctx, a, makeExpr(b ? "true" : "false", { constant: Boolean(b) }));
        break;
      case "move":
        setReg(ctx, a, getReg(ctx, b));
        break;
      case "newtable":
        setReg(ctx, a, makeExpr("{}", { table: { entries: [] } }));
        break;
      case "settable":
      case "settable_kc":
      case "settable_k_const":
      case "settable_r":
      case "settable_rk":
      case "settable_kr": {
        const target = getReg(ctx, a);
        let key = kind === "settable_kr" ? b : fieldKey(instruction, "b");
        let keyExpr = null;
        if (key === null) {
          keyExpr = getReg(ctx, b);
          if (Object.hasOwn(keyExpr, "constant")) {
            key = keyExpr.constant;
            keyExpr = null;
          }
        }
        const value = kind === "settable_kr" || kind === "settable_kc" || kind === "settable_r"
          ? getReg(ctx, c)
          : operandExpr(ctx, instruction, "c");
        if (target.table) target.table.entries.push({ key, keyExpr, value });
        else {
          const targetText = renderExpr(target);
          const renderedKey = keyExpr ? renderExpr(keyExpr) : luaValue(key);
          const assignment = `${prefixExpr(targetText)}[${renderedKey}] = ${renderExpr(value)}`;
          emitSourceLine(ctx, isDirectPrefixExpression(targetText) ? assignment : commentSource(assignment));
        }
        break;
      }
      case "setlist": {
        const target = getReg(ctx, a);
        if (target.table) {
          for (let i = 1; i <= b; i += 1) target.table.entries.push({ key: null, value: getReg(ctx, a + i) });
        }
        break;
      }
      case "setlist_range": {
        const target = getReg(ctx, a);
        if (target.table && typeof b === "number") {
          for (let i = a + 1; i <= b; i += 1) target.table.entries.push({ key: null, value: getReg(ctx, i) });
        }
        break;
      }
      case "append_varargs": {
        const target = getReg(ctx, a);
        if (target.table) target.table.entries.push({ key: null, value: makeExpr("...") });
        break;
      }
      case "gettable_k": {
        const base = getReg(ctx, b);
        const key = immediateExpr(c);
        setReg(ctx, a, lookupTableEntry(base, key) ?? makeExpr(propertyAccess(renderExpr(base), c)));
        break;
      }
      case "gettable_r": {
        const base = getReg(ctx, b);
        const key = getReg(ctx, c);
        setReg(ctx, a, lookupTableEntry(base, key) ?? makeExpr(`${prefixExpr(renderExpr(base))}[${renderExpr(key)}]`));
        break;
      }
      case "self_k": {
        const base = getReg(ctx, b);
        setReg(ctx, a + 1, base);
        setReg(ctx, a, makeExpr(propertyAccess(renderExpr(base), c), { method: c, base: renderExpr(base) }));
        break;
      }
      case "self_r": {
        const base = getReg(ctx, b);
        const key = getReg(ctx, c);
        const baseText = renderExpr(base);
        setReg(ctx, a + 1, base);
        if (typeof key.constant === "string") {
          setReg(ctx, a, makeExpr(propertyAccess(baseText, key.constant), { method: key.constant, base: baseText }));
        } else {
          setReg(ctx, a, makeExpr(`${prefixExpr(baseText)}[${renderExpr(key)}]`));
        }
        break;
      }
      case "closure": {
        const captured = captureUpvalues(ctx, proto, index + 1, c ?? 0, profile);
        const child = childFunctionExpr(proto, b, captured, profile);
        ctx.unknownInstructions += child.unknownInstructions ?? 0;
        setReg(ctx, a, child);
        index += c ?? 0;
        break;
      }
      case "call0_assign1":
      case "call1_assign1":
      case "call_b_assign1":
      case "call_count_assign1":
      case "call_var_assign1": {
        const end = kind === "call0_assign1"
          ? a
          : kind === "call1_assign1"
            ? a + 1
            : kind === "call_count_assign1"
              ? a + b - 1
              : kind === "call_var_assign1"
                ? ctx.topEnd
                : b;
        const call = callExprValue(getReg(ctx, a), collectArgs(ctx, a + 1, end));
        assignSource(ctx, a, call, "");
        break;
      }
      case "call1_results":
      case "call_b_results":
      case "call_var_results":
      case "call1_multiret":
      case "call_b_multiret":
      case "call0_results":
      case "call0_multiret": {
        const end = kind === "call0_multiret" || kind === "call0_results"
          ? a
          : kind === "call1_multiret" || kind === "call1_results"
            ? a + 1
            : kind === "call_var_results"
              ? ctx.topEnd
              : b;
        const call = callExprValue(getReg(ctx, a), collectArgs(ctx, a + 1, end));
        assignSource(ctx, a, call, "");
        ctx.topEnd = a;
        break;
      }
      case "call0_noret":
      case "call1_noret":
      case "call_b_noret":
      case "call_count_noret":
      case "call_var_noret": {
        const end = kind === "call0_noret"
          ? a
          : kind === "call1_noret"
            ? a + 1
            : kind === "call_count_noret"
              ? a + b - 1
              : kind === "call_var_noret"
                ? ctx.topEnd
                : b;
        const callee = getReg(ctx, a);
        const args = collectArgs(ctx, a + 1, end);
        const call = callExprValue(callee, args);
        if (Object.hasOwn(call, "constant")) {
          emitSourceLine(ctx, `-- decoded value: ${luaValue(call.constant)}`);
        } else {
          emitSourceLine(ctx, renderExpr(call));
        }
        break;
      }
      case "add":
      case "sub":
      case "mul":
      case "div":
      case "mod": {
        const op = kind === "add" ? "+" : kind === "sub" ? "-" : kind === "mul" ? "*" : kind === "mod" ? "%" : "/";
        setReg(ctx, a, makeExpr(`(${renderExpr(getReg(ctx, b))} ${op} ${renderExpr(getReg(ctx, c))})`));
        break;
      }
      case "add_k":
      case "sub_k":
      case "mul_k":
      case "div_k":
      case "mod_k": {
        const op = kind.startsWith("add") ? "+" : kind.startsWith("sub") ? "-" : kind.startsWith("mul") ? "*" : kind.startsWith("mod") ? "%" : "/";
        setReg(ctx, a, makeExpr(`(${renderExpr(getReg(ctx, b))} ${op} ${renderExpr(immediateExpr(c))})`));
        break;
      }
      case "add_kr":
      case "div_kr": {
        const op = kind.startsWith("add") ? "+" : "/";
        setReg(ctx, a, makeExpr(`(${renderExpr(immediateExpr(b))} ${op} ${renderExpr(getReg(ctx, c))})`));
        break;
      }
      case "len":
        setReg(ctx, a, makeExpr(`#${renderExpr(getReg(ctx, b))}`));
        break;
      case "not":
        setReg(ctx, a, makeExpr(`not ${renderExpr(getReg(ctx, b))}`));
        break;
      case "concat": {
        const parts = [];
        for (let i = b; i <= c; i += 1) parts.push(renderExpr(getReg(ctx, i)));
        setReg(ctx, a, makeExpr(parts.join(" .. ")));
        break;
      }
      case "return_nil":
        emitSourceLine(ctx, "do return end");
        break;
      case "return_one":
        emitSourceLine(ctx, `do return ${renderExpr(getReg(ctx, a))} end`);
        break;
      case "return_call0":
        emitSourceLine(ctx, `do return ${callExpression(getReg(ctx, a), [])} end`);
        break;
      case "return_call_b":
        emitSourceLine(ctx, `do return ${callExpression(getReg(ctx, a), collectArgs(ctx, a + 1, b))} end`);
        break;
      case "return_two":
        emitSourceLine(ctx, `do return ${renderExpr(getReg(ctx, a))}, ${renderExpr(getReg(ctx, a + 1))} end`);
        break;
      case "return_varargs":
      case "return_range":
        emitSourceLine(ctx, `do return ${renderExpr(getReg(ctx, a))} end`);
        break;
      case "jmp":
      case "forprep":
      case "forloop":
      case "test_truthy":
      case "test_falsy":
      case "testset_truthy":
      case "testset_falsy":
      case "eq_k_jump":
      case "eq_kreg_jump":
      case "ne_k_jump":
      case "eq_reg_jump":
      case "ne_reg_jump":
      case "lt_reg_jump":
      case "lt_kreg_jump":
      case "le_reg_jump":
      case "le_kreg_jump":
      case "tforloop": {
        const comment = controlFlowComment(kind, instruction, ctx);
        if (comment) emitSourceLine(ctx, comment);
        break;
      }
      case "close":
      case "upvalue_marker":
        break;
      case "loadnil":
        setReg(ctx, a, makeExpr("nil"));
        break;
      default:
        ctx.unknownInstructions += 1;
        if (profile.suppressUnknown === false) emitSourceLine(ctx, `-- vm ${formatInstruction(instruction)}`);
        break;
    }
  }

  return ctx;
}

function findNestedPayloadLift(proto, profile) {
  if (!profile.nestedWrapper) return null;
  if (proto.instructions.length > 200 && countOwnDecodedConstantPairs(proto) >= 8) return null;

  const ctx = createLiftContext(proto, []);
  const closures = [];

  for (let index = 0; index < proto.instructions.length; index += 1) {
    const instruction = proto.instructions[index];
    if (instruction.skipped) continue;

    const kind = instructionKind(profile, instruction, proto);
    const a = instruction.a;
    const b = instruction.b;
    const c = instruction.c;

    switch (kind) {
      case "getglobal":
        setReg(ctx, a, makeExpr(isIdentifier(b) ? b : `_ENV[${luaValue(b)}]`));
        break;
      case "getupvalue":
        setReg(ctx, a, cloneExpr(ctx.upvalues[b]) ?? makeExpr(`upvalue_${b}`));
        break;
      case "loadk":
        setReg(ctx, a, operandExpr(ctx, instruction, "b"));
        break;
      case "loadbool":
      case "loadbool_skip":
        setReg(ctx, a, makeExpr(b ? "true" : "false", { constant: Boolean(b) }));
        break;
      case "move":
        setReg(ctx, a, getReg(ctx, b));
        break;
      case "newtable":
        setReg(ctx, a, makeExpr("{}", { table: { entries: [] } }));
        break;
      case "gettable_k": {
        const base = getReg(ctx, b);
        const key = immediateExpr(c);
        setReg(ctx, a, lookupTableEntry(base, key) ?? makeExpr(propertyAccess(renderExpr(base), c)));
        break;
      }
      case "gettable_r": {
        const base = getReg(ctx, b);
        const key = getReg(ctx, c);
        setReg(ctx, a, lookupTableEntry(base, key) ?? makeExpr(`${renderExpr(base)}[${renderExpr(key)}]`));
        break;
      }
      case "settable":
      case "settable_kc":
      case "settable_k_const":
      case "settable_r":
      case "settable_rk":
      case "settable_kr": {
        const target = getReg(ctx, a);
        let key = kind === "settable_kr" ? b : fieldKey(instruction, "b");
        let keyExpr = null;
        if (key === null) {
          keyExpr = getReg(ctx, b);
          if (Object.hasOwn(keyExpr, "constant")) {
            key = keyExpr.constant;
            keyExpr = null;
          }
        }
        const value = kind === "settable_kr" || kind === "settable_kc" || kind === "settable_r"
          ? getReg(ctx, c)
          : operandExpr(ctx, instruction, "c");
        if (target.table) target.table.entries.push({ key, keyExpr, value });
        break;
      }
      case "closure": {
        const child = proto.protos[b];
        const captured = captureUpvalues(ctx, proto, index + 1, c ?? 0, profile);
        const expr = isLikelyXorDecoderProto(child)
          ? makeExpr("__luaobf_xor_decode", { decoder: "xor" })
          : makeExpr(`proto_${child?.path.replace(/\./g, "_") ?? b}`);
        setReg(ctx, a, expr);
        if (child && !isLikelyXorDecoderProto(child)) closures.push({ child, upvalues: captured });
        index += c ?? 0;
        break;
      }
      case "call0_assign1":
      case "call1_assign1":
      case "call_b_assign1":
      case "call_count_assign1":
      case "call_var_assign1":
      case "call1_results":
      case "call_b_results":
      case "call_var_results":
      case "call1_multiret":
      case "call_b_multiret":
      case "call0_results":
      case "call0_multiret": {
        const end = kind === "call0_assign1" || kind === "call0_multiret" || kind === "call0_results"
          ? a
          : kind === "call1_assign1" || kind === "call1_multiret" || kind === "call1_results"
            ? a + 1
            : kind === "call_count_assign1"
              ? a + b - 1
              : kind === "call_var_assign1" || kind === "call_var_results"
                ? ctx.topEnd
                : b;
        setReg(ctx, a, callExprValue(getReg(ctx, a), collectArgs(ctx, a + 1, end)));
        ctx.topEnd = a;
        break;
      }
      default:
        break;
    }
  }

  const payload = closures.sort((left, right) => countInstructions(right.child) - countInstructions(left.child))[0];
  if (!payload) return null;
  return liftProtoBody(payload.child, profile, payload.upvalues);
}

function countMeaningfulLiftLines(lines) {
  return lines.filter((line) => {
    const trimmed = line.trim();
    return trimmed && !trimmed.startsWith("--");
  }).length;
}

function isLowConfidenceLift(proto, lifted) {
  const instructionCount = countInstructions(proto);
  if (instructionCount < 80) return false;

  const meaningful = countMeaningfulLiftLines(lifted.lines);
  if (meaningful <= 2) return true;

  const selfIndexedAssignments = lifted.lines.filter((line) => {
    return /^\s*(?:local\s+)?([A-Za-z_][A-Za-z0-9_]*)\[\1\]\s*=/.test(line);
  }).length;
  const selfCallAssignments = lifted.lines.filter((line) => {
    return /^\s*(?:local\s+)?(v\d+)\s*=\s*\1\(\)/.test(line);
  }).length;

  if (meaningful <= 24 && selfIndexedAssignments + selfCallAssignments >= 3) return true;
  return meaningful <= 6 && selfIndexedAssignments >= Math.ceil(meaningful / 2);
}

function buildLiftedOutput(proto, encodedLength, decodedLength, profile = inferVmProfile(proto)) {
  const lifted = findNestedPayloadLift(proto, profile) ?? liftProtoBody(proto, profile);
  if (lifted.unknownInstructions > 0) {
    const preview = sourcePreview(lifted.lines);
    return {
      code: buildVmListingSource(proto, encodedLength, decodedLength, {
        reason: `${lifted.unknownInstructions} VM instructions remain unclassified; preserving the complete decoded IR`,
        previewLines: preview.lines,
        previewTruncated: preview.truncated
      }),
      outputMode: "vm-ir",
      preservedInstructions: countInstructions(proto)
    };
  }

  if (!profile.allowLowConfidenceLift && isLowConfidenceLift(proto, lifted)) {
    return {
      code: buildVmListingSource(proto, encodedLength, decodedLength, {
        reason: "source lift was low-confidence; preserved decoded VM bytecode instead"
      }),
      outputMode: "vm-ir",
      preservedInstructions: countInstructions(proto)
    };
  }

  return {
    code: [
      OUTPUT_HEADER,
      "",
      ...lifted.lines,
      ""
    ].join("\n"),
    outputMode: "source-lift",
    preservedInstructions: 0
  };
}

function buildRegisterSource(proto) {
  const semantics = proto.instructions.some((instruction) => instruction.kind)
    ? {}
    : inferSemanticMap(proto);
  const lines = [
    OUTPUT_HEADER,
    "-- Fully expanded LuaObfuscator superinstructions",
    "",
    "local unpack = table.unpack or unpack",
    "local protos = {}",
    "local function new_closed_cell(initial)",
    "  local value = initial",
    "  return {",
    "    get = function() return value end,",
    "    set = function(next_value) value = next_value end,",
    "  }",
    "end",
    ""
  ];

  emitRegisterProto(proto, semantics, lines);
  lines.push('return protos["0"](_ENV, {})()');
  lines.push("");
  return lines.join("\n");
}

function countUnknownInstructions(proto) {
  let count = proto.instructions.filter((instruction) =>
    !instruction.skipped && instruction.kind === "unknown"
  ).length;
  for (const child of proto.protos) count += countUnknownInstructions(child);
  return count;
}

function collectUnknownSuperOpcodes(proto, opcodes = new Set()) {
  for (const instruction of proto.instructions) {
    if (!instruction.skipped && instruction.kind === "unknown") {
      opcodes.add(instruction.superOpcode ?? instruction.op);
    }
  }
  for (const child of proto.protos) collectUnknownSuperOpcodes(child, opcodes);
  return opcodes;
}

function buildVmListingSource(proto, encodedLength, decodedLength, options = {}) {
  const decodedStrings = recoverDecodedWrapperStrings(proto);
  const recovered = recoverHighConfidenceSource(proto).filter((line) => {
    return !(line === "-- empty chunk" && (decodedStrings.length > 0 || countInstructions(proto) > 20));
  });
  const lines = [
    OUTPUT_HEADER,
    ""
  ];

  if (options.reason) {
    lines.push(`-- ${options.reason}`);
    lines.push("");
  }

  if (options.previewLines?.length > 0) {
    lines.push("-- best-effort source preview (incomplete; full decoded VM IR follows):");
    for (const line of options.previewLines) {
      lines.push(`-- | ${line}`);
    }
    if (options.previewTruncated) lines.push("-- | ... preview truncated ...");
    lines.push("");
  }

  if (recovered.length > 0) {
    lines.push("-- high-confidence source recovered from constants:");
    lines.push(...recovered);
    lines.push("");
  }

  if (decodedStrings.length > 0) {
    lines.push("-- decoded wrapper strings:");
    decodedStrings.forEach((value, index) => {
      lines.push(`--   [${index + 1}] ${luaValue(value)}`);
    });
    lines.push("");
  }

  lines.push("-- decoded VM bytecode:");
  lines.push(...formatProto(proto));
  lines.push("");
  return lines.join("\n");
}

function sourcePreview(lines, limit = 400) {
  const flattened = lines.flatMap((line) => String(line).replace(/\r\n/g, "\n").split("\n"));
  return {
    lines: flattened.slice(0, limit),
    truncated: flattened.length > limit
  };
}

function buildDecodedOutput(proto, encodedLength, decodedLength, options = {}) {
  const instructionCount = countInstructions(proto);
  const knownGamesenseSource = recoverKnownGamesenseSource(proto);
  if (knownGamesenseSource) {
    return {
      code: [
        OUTPUT_HEADER,
        "",
        ...knownGamesenseSource,
        ""
      ].join("\n"),
      outputMode: "recovered-source",
      instructionCount,
      preservedInstructions: 0
    };
  }

  const inlineXorSource = recoverInlineXorSource(proto);
  if (inlineXorSource && instructionCount < 100) {
    return {
      code: [
        OUTPUT_HEADER,
        "",
        ...inlineXorSource,
        ""
      ].join("\n"),
      outputMode: "recovered-source",
      instructionCount,
      preservedInstructions: 0
    };
  }

  const profile = inferVmProfile(proto);
  const recovered = recoverLikelySource(proto);

  if (recovered.length > 0 && instructionCount < 90 && !hasLiftProfile(profile)) {
    return {
      code: [
        OUTPUT_HEADER,
        "",
        ...recovered,
        ""
      ].join("\n"),
      outputMode: "recovered-source",
      instructionCount,
      preservedInstructions: 0
    };
  }

  if (hasLiftProfile(profile) || profile.preserveVmIr || profile.preferDispatcherAnalysis) {
    try {
      const analysis = analyzeSuperinstructionVm(
        options.source,
        options.payloadStart,
        maxOpcode(proto)
      );
      if (analysis) {
        const expanded = expandSuperinstructionProto(proto, analysis);
        const unknownCount = countUnknownInstructions(expanded);
        if (unknownCount === 0) {
          return {
            code: buildRegisterSource(expanded),
            outputMode: "devirtualized",
            instructionCount,
            expandedInstructionCount: countInstructions(expanded),
            preservedInstructions: 0
          };
        }

        const unknownOpcodes = [...collectUnknownSuperOpcodes(expanded)]
          .sort((left, right) => left - right);
        options.onSuperinstructionError?.(
          new Error(`unclassified superinstructions: ${unknownOpcodes.join(", ")}`)
        );
      }
    } catch (error) {
      options.onSuperinstructionError?.(error);
    }
  }

  if (hasLiftProfile(profile)) {
    if (profile.preserveVmIr) {
      const lifted = findNestedPayloadLift(proto, profile) ?? liftProtoBody(proto, profile);
      const preview = sourcePreview(lifted.lines);
      return {
        code: buildVmListingSource(proto, encodedLength, decodedLength, {
          reason: `newer superinstruction VM detected (${profile.opcodeStats.distinctOpcodes} distinct opcodes); preserving the complete decoded IR`,
          previewLines: preview.lines,
          previewTruncated: preview.truncated
        }),
        outputMode: "vm-ir",
        instructionCount,
        expandedInstructionCount: 0,
        preservedInstructions: instructionCount
      };
    }

    const lifted = buildLiftedOutput(proto, encodedLength, decodedLength, profile);
    return {
      code: lifted.code,
      outputMode: lifted.outputMode,
      instructionCount,
      expandedInstructionCount: 0,
      preservedInstructions: lifted.preservedInstructions
    };
  }

  return {
    code: buildVmListingSource(proto, encodedLength, decodedLength),
    outputMode: "vm-ir",
    instructionCount,
    expandedInstructionCount: 0,
    preservedInstructions: instructionCount
  };
}

function extractVmPayload(source) {
  const callPattern = /\breturn\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
  let match;

  while ((match = callPattern.exec(source)) !== null) {
    let index = match.index + match[0].length;
    while (/\s/.test(source[index] ?? "")) index += 1;
    if (source[index] !== '"' && source[index] !== "'") continue;

    const parsed = readLuaQuotedString(source, index);
    const encoded = Buffer.from(parsed.bytes).toString("latin1");
    if (!encoded.startsWith("LOL!")) continue;

    return { encoded, start: match.index, end: parsed.end };
  }

  return null;
}

export function decodeLuaObfuscatorVm(source) {
  const payload = extractVmPayload(source);
  if (!payload) {
    return {
      code: source,
      decodedPayloads: 0,
      decodedBytes: 0,
      outputMode: "source",
      instructionCount: 0,
      expandedInstructionCount: 0,
      preservedInstructions: 0,
      proto: null
    };
  }

  const bytes = decodeEncodedVmString(payload.encoded);
  const reader = new ByteReader(bytes);
  const proto = parseProto(reader);
  let superinstructionError = null;
  const output = buildDecodedOutput(proto, payload.encoded.length, bytes.length, {
    source,
    payloadStart: payload.start,
    onSuperinstructionError: (error) => {
      superinstructionError = error;
    }
  });

  return {
    code: output.code,
    decodedPayloads: 1,
    decodedBytes: bytes.length,
    outputMode: output.outputMode,
    instructionCount: output.instructionCount,
    expandedInstructionCount: output.expandedInstructionCount ?? 0,
    preservedInstructions: output.preservedInstructions,
    superinstructionError: superinstructionError?.message ?? null,
    proto: {
      ...proto,
      constantsFlat: collectConstants(proto)
    }
  };
}
