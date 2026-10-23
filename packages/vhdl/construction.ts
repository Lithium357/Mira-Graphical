// SPDX-License-Identifier: GPL-3.0-only
import type {
  ClipboardItem,
  CreateComponent,
  Edit,
  InputPort,
  SourceAction,
} from '../protocol/index.js';
import {
  children,
  expressionSpan,
  expressions,
  graphPatch,
  parse,
  project,
  type Expr,
  type Module,
  type Net,
} from '../verilog/index.js';
import { PatchDraft } from '../verilog/patches.js';
import {
  assertVhdlName,
  inferVhdl,
  nativeLiteral,
  literalInput,
  nativeRange,
  tokenizeVhdl,
  vhdlOperator,
  type VhdlType,
} from './index.js';
const zero = (width: number, type: VhdlType) => nativeLiteral(`${width}'d0`, type);
const safe = (source: string, edit: Edit) => {
  if (/--|\/\*/.test(source.slice(edit.start, edit.end)))
    throw new Error(
      'This edit would remove a comment. Edit that region in the source editor instead.',
    );
  return edit;
};
function insert(source: string, at: number, lines: string[]): Edit {
  const newline = source.includes('\r\n') ? '\r\n' : '\n',
    line = source.lastIndexOf('\n', at - 1) + 1;
  const start = /^[\t ]*$/.test(source.slice(line, at)) ? line : at;
  return {
    start,
    end: start,
    text:
      (start && !source.slice(0, start).endsWith('\n') ? newline : '') +
      lines.map((s) => '    ' + s + newline).join(''),
  };
}
const body = (source: string, ast: Module, lines: string[]) =>
  insert(source, ast.endmoduleStart, lines);
const declarations = (source: string, ast: Module, lines: string[]) =>
  insert(source, ast.vhdl!.declarationsEnd, lines);
function bounds(width: number, range?: string) {
  if (!Number.isSafeInteger(width) || width < 1 || width > 4096)
    throw new Error('Choose a width between 1 and 4096 bits.');
  if (range !== undefined) {
    const m = /^\[([0-9]+):([0-9]+)\]$/.exec(range);
    if (
      !m ||
      Math.abs(Number(m[1]) - Number(m[2])) + 1 !== width ||
      [m[1], m[2]].some((n) => Number(n) > 2147483647)
    )
      throw new Error('Declaration range must match the bus width.');
    return nativeRange(Number(m[1]), Number(m[2]));
  }
  return nativeRange(width - 1, 0);
}
const declaration = (width: number, type: VhdlType, range?: string) =>
  type === 'std_logic'
    ? width === 1
      ? 'std_logic'
      : (() => {
          throw new Error('std_logic requires one bit.');
        })()
    : type + bounds(width, range);
const nativeType = (width: number, preferred?: VhdlType): VhdlType =>
  preferred ?? (width === 1 ? 'std_logic' : 'unsigned');
export function renderVhdl(e: Expr): string {
  if (e.kind === 'ref') return e.value;
  if (e.kind === 'literal') return nativeLiteral(e.value, e.nativeType ?? 'unsigned');
  if (e.kind === 'slice') return e.value + nativeRange(e.msb, e.lsb, e.bit);
  if (e.kind === 'convert' && e.qualified && e.value.kind === 'literal')
    return `${e.conversion}'(${nativeLiteral(e.value.value, 'std_logic_vector')})`;
  if (e.kind === 'convert')
    return `${e.conversion}${e.qualified ? "'" : ''}(${renderVhdl(e.value)}${e.resultWidth !== undefined ? ', ' + e.resultWidth : ''})`;
  if (e.kind === 'op')
    return `(${renderVhdl(e.left)} ${vhdlOperator(e.op)} ${renderVhdl(e.right)})`;
  if (e.kind === 'concat') return `(${e.parts.map(renderVhdl).join(' & ')})`;
  return `${renderVhdl(e.truthy)} when ${renderVhdl(e.condition)} = '1' else ${renderVhdl(e.falsy)}`;
}
function checked(source: string, edits: Edit[]): Edit[] {
  const draft = new PatchDraft(source);
  draft.apply(edits);
  project(parse(draft.text));
  return edits;
}
function create(source: string, ast: Module, action: CreateComponent, type?: VhdlType): Edit[] {
  assertVhdlName(action.name);
  const name = action.name.toLowerCase();
  bounds(action.width, action.netRange);
  if (ast.nets.some((n) => n.name === name) || ast.instances.some((n) => n.name === name))
    throw new Error('A signal or instance with that case-insensitive name already exists.');
  const t = nativeType(action.width, type),
    dtype = declaration(action.width, t, action.netRange);
  if (action.component === 'input' || action.component === 'output') {
    const line = `${name} : ${action.component === 'input' ? 'in' : 'out'} ${dtype}`;
    if (ast.portClose < 0) return [insert(source, ast.vhdl!.entityEndStart, [`port (${line});`])];
    return [{ start: ast.lastPortEnd, end: ast.lastPortEnd, text: '; ' + line }];
  }
  if (action.component === 'instance') {
    const child = ast.library[action.moduleName?.toLowerCase() ?? ''];
    if (!child || child.name === ast.name)
      throw new Error('Choose another entity definition in this shared document.');
    const lines: string[] = [],
      ports: string[] = [];
    for (const p of child.nets.filter((n) => n.direction !== 'wire')) {
      if (p.direction === 'input') ports.push(`${p.name} => ${zero(p.width, p.nativeType!)}`);
      else {
        const output = `${name}_${p.name}`;
        assertVhdlName(output);
        if (ast.nets.some((n) => n.name === output))
          throw new Error(`Signal ${output} already exists.`);
        lines.push(`signal ${output} : ${declaration(p.width, p.nativeType!)};`);
        ports.push(`${p.name} => ${output}`);
      }
    }
    return [
      ...(lines.length ? [declarations(source, ast, lines)] : []),
      body(source, ast, [`${name} : entity work.${child.name} port map (${ports.join(', ')});`]),
    ];
  }
  if (action.component === 'split') {
    const net = ast.nets.find((n) => n.name === action.source?.toLowerCase());
    if (
      !net ||
      net.nativeType === 'std_logic' ||
      net.width % action.width ||
      net.width / action.width > 64
    )
      throw new Error('Choose an array divisible into at most 64 equal parts.');
    const signals: string[] = [],
      assignments: string[] = [];
    for (let j = 0; j < net.width / action.width; j++) {
      const part = `${name}_${j}`;
      assertVhdlName(part);
      if (ast.nets.some((n) => n.name === part)) throw new Error(`Signal ${part} already exists.`);
      const direction = net.msb >= net.lsb ? 1 : -1,
        lo = net.lsb + direction * j * action.width,
        hi = lo + direction * (action.width - 1),
        partType = action.width === 1 ? 'std_logic' : net.nativeType!;
      signals.push(`signal ${part} : ${declaration(action.width, partType)};`);
      assignments.push(`${part} <= ${net.name}${nativeRange(hi, lo, action.width === 1)};`);
    }
    return [declarations(source, ast, signals), body(source, ast, assignments)];
  }
  let expression: string | undefined,
    resultType = t,
    resultWidth = action.width;
  if (action.component === 'operation') {
    if (!['+', '-', '*', '&', '|', '^'].includes(action.operator ?? ''))
      throw new Error('Choose a supported operator.');
    if (['+', '-', '*'].includes(action.operator!) && t === 'std_logic')
      throw new Error(
        'Use an array width of at least two bits for VHDL arithmetic; scalar logic supports AND/OR/XOR.',
      );
    expression = `${zero(action.width, t)} ${vhdlOperator(action.operator!)} ${zero(action.width, t)}`;
    if (action.operator === '*') expression = `resize(${expression}, ${action.width})`;
  } else if (action.component === 'mux')
    expression = `${zero(action.width, t)} when '0' = '1' else ${zero(action.width, t)}`;
  else if (action.component === 'constant') expression = literalInput(action.value ?? '', t);
  else if (action.component === 'slice') {
    const net = ast.nets.find((n) => n.name === action.source?.toLowerCase()),
      range = /^\[([0-9]+)(?::([0-9]+))?\]$/.exec(action.range ?? '');
    if (!net || !range)
      throw new Error('Choose a declared array and a fixed graph [bit] or [left:right] range.');
    const bit = range[2] === undefined,
      msb = Number(range[1]),
      lsb = Number(range[2] ?? range[1]);
    resultWidth = Math.abs(msb - lsb) + 1;
    resultType = bit ? 'std_logic' : net.nativeType!;
    expression = net.name + nativeRange(msb, lsb, bit);
  } else if (action.component === 'concat') {
    const parts = action.parts?.map((name) => ast.nets.find((n) => n.name === name.toLowerCase()));
    if (!parts || parts.length < 2 || parts.length > 64 || parts.some((p) => !p))
      throw new Error('Join 2–64 declared signals in MSB-first order.');
    const arrays = parts.filter((p) => p!.nativeType !== 'std_logic');
    resultType = arrays[0]?.nativeType ?? 'std_logic_vector';
    if (arrays.some((p) => p!.nativeType !== resultType))
      throw new Error('Convert join operands to a common array type in source first.');
    resultWidth = parts.reduce((w, p) => w + p!.width, 0);
    expression = parts.map((p) => p!.name).join(' & ');
  } else if (action.component !== 'wire') throw new Error('Unsupported VHDL component.');
  if (resultWidth !== action.width)
    throw new Error('The component width must match its slice or join result.');
  return [
    declarations(source, ast, [
      `signal ${name} : ${declaration(action.width, resultType, action.netRange)};`,
    ]),
    ...(expression ? [body(source, ast, [`${name} <= ${expression};`])] : []),
  ];
}
function socket(e: Expr, port: InputPort): Expr {
  if (e.kind === 'convert' && port === 'left') return e.value;
  if (e.kind === 'concat' && /^part:[0-9]+$/.test(port)) {
    const part = e.parts[Number(port.slice(5))];
    if (part) return part;
  }
  if (e.kind === 'op' && (port === 'left' || port === 'right')) return e[port];
  if (e.kind === 'mux') {
    if (port === 'select') return e.condition;
    if (port === 'left') return e.truthy;
    if (port === 'right') return e.falsy;
  }
  throw new Error('That component has no matching input socket.');
}
function reference(net: Net, expected: { type: VhdlType; width: number }): string {
  if (expected.type === 'std_logic')
    return net.nativeType === 'std_logic' ? net.name : `${net.name}(${net.lsb})`;
  let text = net.name,
    width = net.width;
  if (net.nativeType === 'std_logic') {
    text = `unsigned'('0' & ${text})`;
    width = 2;
  } else if (net.nativeType === 'std_logic_vector') text = `unsigned(${text})`;
  if (width !== expected.width) text = `resize(${text}, ${expected.width})`;
  if (expected.type === 'std_logic_vector') text = `std_logic_vector(${text})`;
  return net.nativeType === expected.type && net.width === expected.width ? net.name : text;
}
const refers = (e: Expr, name: string): boolean =>
  e.kind === 'ref' || e.kind === 'slice'
    ? e.value === name
    : children(e).some(([, c]) => refers(c, name));
export function vhdlActionEdits(source: string, action: SourceAction): Edit[] {
  if (!action || typeof action !== 'object') throw new Error('Invalid construction action.');
  const ast = parse(source, action.scope),
    graph = project(ast);
  if (ast.language !== 'vhdl') throw new Error('Expected a VHDL document.');
  if (action.kind === 'create') return checked(source, create(source, ast, action));
  if (action.kind === 'module') {
    assertVhdlName(action.name);
    const name = action.name.toLowerCase();
    if (ast.library[name]) throw new Error('Entity name already exists.');
    return checked(source, [
      {
        start: source.length,
        end: source.length,
        text: `\nlibrary ieee;\nuse ieee.std_logic_1164.all;\nuse ieee.numeric_std.all;\nentity ${name} is\nend entity ${name};\narchitecture rtl of ${name} is\nbegin\nend architecture rtl;\n`,
      },
    ]);
  }
  if (action.kind === 'import') {
    if (
      !Array.isArray(action.definitions) ||
      !action.definitions.length ||
      action.definitions.length > 64 ||
      action.definitions.some((s) => typeof s !== 'string') ||
      action.definitions.join('').length > 500000
    )
      throw new Error('Invalid entity import.');
    const imported = parse(action.definitions.join('\n'));
    if (imported.language !== 'vhdl')
      throw new Error(
        'Import VHDL entities into a VHDL document. Mixed-language elaboration is unsupported.',
      );
    for (const name of Object.keys(imported.library))
      if (ast.library[name]) throw new Error(`Entity ${name} already exists.`);
    return checked(source, [
      {
        start: source.length,
        end: source.length,
        text: '\n' + action.definitions.join('\n\n') + '\n',
      },
    ]);
  }
  if (action.kind === 'paste') return paste(source, ast, action.items);
  const target = graph.nodes.find((n) => n.key === action.target);
  if (!target) throw new Error('The target no longer exists.');
  if (action.kind === 'change') return [graphPatch(source, graph, target.id, action.change)];
  const expr = expressions(ast).get(target.expressionKey ?? target.key),
    driver = ast.assigns.find(
      (a) =>
        a.target ===
        (['input', 'output', 'wire'].includes(target.kind)
          ? target.label
          : target.assignmentTarget),
    );
  if (action.kind === 'connect') {
    const from = graph.nodes.find((n) => n.key === action.source),
      net = ast.nets.find((n) => n.name === from?.sourceNet);
    if (!net) throw new Error('Connect from a named signal or component result.');
    if (target.kind === 'instance') {
      const inst = ast.instances.find((i) => i.name === target.label)!,
        port = inst.ports.find((p) => `port:${p.name}` === action.port),
        definition = ast.library[inst.module].nets.find(
          (n) => `port:${n.name}` === action.port && n.direction === 'input',
        );
      if (!port || !definition) throw new Error('Choose an instance input port.');
      return checked(source, [
        safe(source, {
          ...expressionSpan(port.expr),
          text: reference(net, { type: definition.nativeType!, width: definition.width }),
        }),
      ]);
    }
    if (['input', 'wire', 'output'].includes(target.kind)) {
      const declaration = ast.nets.find((n) => n.name === target.label)!;
      if (declaration.direction === 'input' || action.port !== 'left')
        throw new Error('Inputs cannot have drivers.');
      if (
        ast.instances.some((i) =>
          i.ports.some(
            (p) =>
              p.expr.kind === 'ref' &&
              p.expr.value === target.label &&
              ast.library[i.module].nets.some((n) => n.name === p.name && n.direction === 'output'),
          ),
        )
      )
        throw new Error('This signal is driven by an instance output.');
      const text = reference(net, { type: declaration.nativeType!, width: declaration.width });
      return checked(
        source,
        driver
          ? [
              safe(
                source,
                /^if\b/i.test(source.slice(driver.start))
                  ? { start: driver.start, end: driver.end, text: `${driver.target} <= ${text};` }
                  : { ...expressionSpan(driver.expr), text },
              ),
            ]
          : [body(source, ast, [`${declaration.name} <= ${text};`])],
      );
    }
    if (!expr) throw new Error('Expression no longer exists.');
    if (expr.kind === 'slice' && action.port === 'left')
      return checked(source, [
        { start: expr.start, end: expr.start + expr.value.length, text: net.name },
      ]);
    const selected = socket(expr, action.port),
      expected = inferVhdl(selected, ast);
    return checked(source, [
      safe(source, { ...expressionSpan(selected), text: reference(net, expected) }),
    ]);
  }
  if (action.kind === 'zero') {
    if (target.kind === 'instance') {
      const inst = ast.instances.find((i) => i.name === target.label)!,
        port = inst.ports.find((p) => `port:${p.name}` === action.port),
        definition = ast.library[inst.module].nets.find(
          (n) => `port:${n.name}` === action.port && n.direction === 'input',
        );
      if (!port || !definition) throw new Error('Choose an instance input.');
      return checked(source, [
        safe(source, {
          ...expressionSpan(port.expr),
          text: zero(definition.width, definition.nativeType!),
        }),
      ]);
    }
    if (!expr) throw new Error('Select an expression or input socket.');
    const selected = action.port ? socket(expr, action.port) : expr,
      expected = inferVhdl(selected, ast);
    return checked(source, [
      safe(
        source,
        selected === driver?.expr && /^if\b/i.test(source.slice(driver.start))
          ? {
              start: driver.start,
              end: driver.end,
              text: `${driver.target} <= ${zero(expected.width, expected.type)};`,
            }
          : { ...expressionSpan(selected), text: zero(expected.width, expected.type) },
      ),
    ]);
  }
  if (action.kind === 'disconnect') {
    if (!driver) throw new Error('This component has no named driver.');
    return checked(source, [safe(source, { start: driver.start, end: driver.end, text: '' })]);
  }
  if (action.kind === 'remove') {
    if (target.kind === 'instance') {
      const inst = ast.instances.find((i) => i.name === target.label)!;
      return checked(source, [safe(source, { start: inst.start, end: inst.end, text: '' })]);
    }
    const name = target.kind === 'wire' ? target.label : target.assignmentTarget;
    if (!name)
      throw new Error(
        'Keep entity ports in the interface; inner expressions can be replaced with zero.',
      );
    if (
      ast.assigns.some((a) => a.target !== name && refers(a.expr, name)) ||
      ast.instances.some((i) => i.ports.some((p) => refers(p.expr, name)))
    )
      throw new Error('This result still has consumers. Disconnect them first.');
    const n = ast.nets.find((n) => n.name === name)!,
      edits: Edit[] = [];
    if (driver) edits.push(safe(source, { start: driver.start, end: driver.end, text: '' }));
    if (n.direction === 'wire') {
      if (
        n.declarationStart === undefined ||
        ast.nets.filter((p) => p.declarationStart === n.declarationStart).length !== 1
      )
        throw new Error('Split shared signal declarations in source before deleting them.');
      edits.push(safe(source, { start: n.declarationStart, end: n.declarationEnd!, text: '' }));
    }
    if (!edits.length) throw new Error('No removable component.');
    return checked(source, edits);
  }
  throw new Error('Unsupported VHDL construction action.');
}
export function copyVhdl(
  source: string,
  graph: ReturnType<typeof project>,
  ids: string[],
): ClipboardItem[] {
  if (!Array.isArray(ids) || !ids.length || ids.length > 50)
    throw new Error('Select 1–50 components to copy.');
  const ast = parse(source, graph.module),
    signals = new Set<string>(),
    ports = new Set<string>(),
    instances = new Set<string>();
  for (const id of ids) {
    const node = graph.nodes.find((n) => n.id === id);
    if (!node) throw new Error('Selection no longer exists.');
    if (node.kind === 'instance') {
      instances.add(node.label);
      for (const p of node.outputPorts ?? []) signals.add(p.signal);
    } else {
      const name =
        node.assignmentTarget ??
        (['input', 'output', 'wire'].includes(node.kind)
          ? node.label
          : node.expressionKey?.split('/assign/')[1]?.split('/')[0]);
      if (!name) throw new Error('Copy a named signal, result or instance.');
      signals.add(name);
      if (['input', 'output'].includes(node.kind)) ports.add(name);
    }
  }
  const result: ClipboardItem[] = [...signals].map((name) => {
    const n = ast.nets.find((n) => n.name === name)!,
      a = ast.assigns.find((a) => a.target === name);
    return {
      name,
      width: n.width,
      language: 'vhdl',
      nativeType: n.nativeType,
      ...(n.width > 1 || n.nativeType !== 'std_logic' ? { netRange: `[${n.msb}:${n.lsb}]` } : {}),
      ...(ports.has(name) && n.direction !== 'wire' ? { direction: n.direction } : {}),
      ...(a ? { expression: renderVhdl(a.expr) } : {}),
    };
  });
  for (const name of instances) {
    const inst = ast.instances.find((i) => i.name === name)!;
    result.push({
      name,
      width: 1,
      language: 'vhdl',
      instance: {
        module: inst.module,
        ports: Object.fromEntries(inst.ports.map((p) => [p.name, renderVhdl(p.expr)])),
      },
    });
  }
  if (result.length > 50) throw new Error('Selection and instance outputs exceed 50 items.');
  return result;
}
function paste(source: string, ast: Module, items: ClipboardItem[]): Edit[] {
  if (!Array.isArray(items) || !items.length || items.length > 50)
    throw new Error('Paste 1–50 clipboard items.');
  const occupied = new Set([...ast.nets.map((n) => n.name), ...ast.instances.map((i) => i.name)]),
    mapping = new Map<string, string>();
  for (const item of items) {
    if (item.language !== 'vhdl')
      throw new Error('Clipboard expressions must come from the same HDL family.');
    assertVhdlName(item.name);
    bounds(item.width, item.netRange);
    if (
      item.nativeType !== undefined &&
      !['std_logic', 'unsigned', 'std_logic_vector'].includes(item.nativeType)
    )
      throw new Error('Invalid VHDL type.');
    if (mapping.has(item.name)) throw new Error('Duplicate clipboard name.');
    let index = 1,
      name = `${item.name}_copy${index}`;
    while (occupied.has(name)) name = `${item.name}_copy${++index}`;
    assertVhdlName(name);
    mapping.set(item.name, name);
    occupied.add(name);
  }
  const rename = (text: string) => {
    if (typeof text !== 'string' || text.length > 32768 || /;|--|\/\*/.test(text))
      throw new Error('Clipboard expressions cannot contain statements or comments.');
    const draft = new PatchDraft(text);
    draft.apply(
      tokenizeVhdl(text)
        .filter((t) => mapping.has(t.image))
        .map((t) => ({ start: t.start, end: t.end, text: mapping.get(t.image)! })),
    );
    return draft.text;
  };
  const draft = new PatchDraft(source);
  for (const item of items.filter((i) => !i.instance))
    draft.apply(
      create(
        draft.text,
        parse(draft.text, ast.name),
        {
          kind: 'create',
          component: item.direction ?? 'wire',
          name: mapping.get(item.name)!,
          width: item.width,
          netRange: item.netRange,
        },
        item.nativeType,
      ),
    );
  const lines: string[] = [];
  for (const item of items) {
    if (item.expression !== undefined) {
      if (item.instance || item.direction === 'input') throw new Error('Invalid clipboard driver.');
      lines.push(`${mapping.get(item.name)} <= ${rename(item.expression)};`);
    }
    if (item.instance) {
      assertVhdlName(item.instance.module);
      const bindings = Object.entries(item.instance.ports).map(([name, text]) => {
        assertVhdlName(name);
        return `${name} => ${rename(text)}`;
      });
      lines.push(
        `${mapping.get(item.name)} : entity work.${item.instance.module} port map (${bindings.join(', ')});`,
      );
    }
  }
  if (lines.length) draft.apply([body(draft.text, parse(draft.text, ast.name), lines)]);
  project(parse(draft.text, ast.name));
  return draft.edits();
}
