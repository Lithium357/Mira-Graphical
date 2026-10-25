// SPDX-License-Identifier: GPL-3.0-only
import {
  operators,
  type SourceAction,
  type Edit,
  type InputPort,
  type CreateComponent,
  type ClipboardItem,
} from '../protocol/index.js';
import {
  parse,
  project,
  expressions,
  expressionSpan,
  graphPatch,
  assertIdentifier,
  type Expr,
  type Module,
  type Node,
  children,
  expressionSigned,
  expressionWidth,
  type Net,
} from './index.js';
import { literalWidth } from './literals.js';
import { PatchDraft } from './patches.js';
import { registerEdits, requireIndependentDriver } from './register-edit.js';
import { isVhdl } from '../vhdl/index.js';
import { vhdlActionEdits, copyVhdl } from '../vhdl/construction.js';
const zero = (width: number) => `${width}'d0`;
const netKind = (node: Node) => ['input', 'output', 'wire'].includes(node.kind);
function declarationWidth(width: number, range?: string) {
  if (!Number.isSafeInteger(width) || width < 1 || width > 4096)
    throw new Error('Choose a width between 1 and 4096 bits.');
  if (range !== undefined) {
    if (typeof range !== 'string') throw new Error('Invalid declaration range.');
    const match = /^\[([0-9]+):([0-9]+)\]$/.exec(range);
    if (
      !match ||
      [Number(match[1]), Number(match[2])].some(
        (n) => !Number.isSafeInteger(n) || n > 2147483647,
      ) ||
      Math.abs(Number(match[1]) - Number(match[2])) + 1 !== width
    )
      throw new Error('Declaration range must match its width.');
    return range + ' ';
  }
  return width === 1 ? '' : `[${width - 1}:0] `;
}
function withoutComments(source: string, edit: Edit): Edit {
  if (/\/\/|\/\*/.test(source.slice(edit.start, edit.end)))
    throw new Error(
      'This structural edit would remove a comment. Edit that region in VS Code instead.',
    );
  return edit;
}
export function bodyInsertion(source: string, ast: Module, statements: string[]): Edit {
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const sample =
    ast.assigns[0]?.start ??
    ast.nets.find((n) => n.declarationStart !== undefined)?.declarationStart;
  const existing =
    sample === undefined ? '' : source.slice(source.lastIndexOf('\n', sample - 1) + 1, sample);
  const indent = /^[\t ]+$/.test(existing) ? existing : '    ';
  const line = source.lastIndexOf('\n', ast.endmoduleStart - 1) + 1;
  const start = /^[\t ]*$/.test(source.slice(line, ast.endmoduleStart)) ? line : ast.endmoduleStart;
  return {
    start,
    end: start,
    text:
      (start > 0 && !source.slice(0, start).endsWith('\n') ? newline : '') +
      statements.map((s) => indent + s + newline).join(''),
  };
}
function create(source: string, ast: Module, action: CreateComponent): Edit[] {
  assertIdentifier(action.name);
  if (
    ast.nets.some((n) => n.name === action.name) ||
    ast.instances.some((n) => n.name === action.name)
  )
    throw new Error('A signal with that name already exists.');
  if (!Number.isSafeInteger(action.width) || action.width < 1 || action.width > 4096)
    throw new Error('Choose a width between 1 and 4096 bits.');
  const width = declarationWidth(action.width, action.netRange);
  if (action.signed !== undefined && typeof action.signed !== 'boolean')
    throw new Error('Invalid signed declaration.');
  const signed = action.signed ? 'signed ' : '';
  if (action.component === 'input' || action.component === 'output') {
    const declaration = `${action.component} wire ${signed}${width}${action.name}`;
    const line = source.lastIndexOf('\n', ast.portClose - 1) + 1;
    if (line > source.indexOf('(') && /^[\t ]*$/.test(source.slice(line, ast.portClose))) {
      return [
        ...(ast.portCount ? [{ start: ast.lastPortEnd, end: ast.lastPortEnd, text: ',' }] : []),
        {
          start: line,
          end: line,
          text: `    ${declaration}${source.includes('\r\n') ? '\r\n' : '\n'}`,
        },
      ];
    }
    return [
      {
        start: ast.portCount ? ast.lastPortEnd : ast.portClose,
        end: ast.portCount ? ast.lastPortEnd : ast.portClose,
        text: (ast.portCount ? ', ' : '') + declaration,
      },
    ];
  }
  if (action.component === 'register') {
    const control = (name: string | undefined) => {
      if (!ast.nets.some((n) => n.name === name && n.direction === 'input' && n.width === 1))
        throw new Error('Choose scalar input ports for register clock/reset.');
      return name!;
    };
    const clock = control(action.clock),
      reset = action.reset ? control(action.reset) : undefined;
    if (action.edge !== undefined && !['posedge', 'negedge'].includes(action.edge))
      throw new Error('Invalid register clock edge.');
    if (action.resetActive !== undefined && !['0', '1'].includes(action.resetActive))
      throw new Error('Invalid reset polarity.');
    if (reset === clock) throw new Error('Clock and reset must be distinct.');
    const data = action.source ? ast.nets.find((n) => n.name === action.source) : undefined;
    if (action.source && !data) throw new Error('Choose a declared data signal.');
    const value = data?.name ?? zero(action.width),
      edge = action.edge ?? 'posedge',
      low = action.resetActive === '0';
    const process = reset
      ? 'always @(' +
        edge +
        ' ' +
        clock +
        ' or ' +
        (low ? 'negedge' : 'posedge') +
        ' ' +
        reset +
        ') if (' +
        (low ? '!' : '') +
        reset +
        ') ' +
        action.name +
        ' <= ' +
        zero(action.width) +
        '; else ' +
        action.name +
        ' <= ' +
        value +
        ';'
      : 'always @(' + edge + ' ' + clock + ') ' + action.name + ' <= ' + value + ';';
    return [bodyInsertion(source, ast, ['reg ' + signed + width + action.name + ';', process])];
  }
  if (action.component === 'instance') {
    const child = ast.library[action.moduleName ?? ''];
    if (!child || child.name === ast.name)
      throw new Error('Choose another module definition from this document.');
    const lines: string[] = [],
      bindings: string[] = [];
    for (const port of child.nets.filter((n) => n.direction !== 'wire')) {
      if (port.direction === 'input') bindings.push(`.${port.name}(${zero(port.width)})`);
      else {
        const name = `${action.name}_${port.name}`;
        assertIdentifier(name);
        if (ast.nets.some((n) => n.name === name))
          throw new Error(`Signal ${name} already exists.`);
        lines.push(`wire ${port.width === 1 ? '' : `[${port.width - 1}:0] `}${name};`);
        bindings.push(`.${port.name}(${name})`);
      }
    }
    lines.push(`${child.name} ${action.name} (${bindings.join(', ')});`);
    return [bodyInsertion(source, ast, lines)];
  }
  if (action.component === 'split') {
    const net = ast.nets.find((n) => n.name === action.source);
    if (!net || net.width % action.width || net.width / action.width > 64)
      throw new Error('Choose a declared bus divisible into at most 64 equal parts.');
    const lines: string[] = [];
    for (let i = 0; i < net.width / action.width; i++) {
      const name = `${action.name}_${i}`;
      assertIdentifier(name);
      if (ast.nets.some((n) => n.name === name)) throw new Error(`Signal ${name} already exists.`);
      const direction = net.msb >= net.lsb ? 1 : -1,
        lo = net.lsb + direction * i * action.width,
        hi = lo + direction * (action.width - 1);
      lines.push(
        `wire ${width}${name};`,
        `assign ${name} = ${net.name}[${action.width === 1 ? lo : `${hi}:${lo}`}];`,
      );
    }
    return [bodyInsertion(source, ast, lines)];
  }
  const statements = [`wire ${signed}${width}${action.name};`];
  let expression: string | undefined;
  if (action.component === 'operation') {
    if (!operators.includes(action.operator!)) throw new Error('Choose a supported operation.');
    expression =
      action.operator === '~' || action.operator === '!'
        ? `${action.operator}${zero(action.width)}`
        : `${zero(action.width)} ${action.operator} ${zero(action.width)}`;
  } else if (action.component === 'mux')
    expression = `1'd0 ? ${zero(action.width)} : ${zero(action.width)}`;
  else if (action.component === 'constant') {
    literalWidth(action.value ?? '');
    expression = action.value;
  } else if (action.component === 'slice') {
    if (
      !ast.nets.some((n) => n.name === action.source) ||
      !/^\[[0-9]+(?::[0-9]+)?\]$/.test(action.range ?? '')
    )
      throw new Error('Choose a declared source and a fixed [bit] or [msb:lsb] range.');
    expression = action.source + action.range!;
  } else if (action.component === 'concat') {
    if (
      !Array.isArray(action.parts) ||
      action.parts.length < 2 ||
      action.parts.length > 64 ||
      action.parts.some((p) => !ast.nets.some((n) => n.name === p))
    )
      throw new Error('Join 2–64 declared signals in MSB-first order.');
    expression = `{${action.parts.join(', ')}}`;
  } else if (action.component !== 'wire') throw new Error('Unsupported component type.');
  if (expression) statements.push(`assign ${action.name} = ${expression};`);
  return [bodyInsertion(source, ast, statements)];
}
function operand(e: Expr, port: InputPort): Expr {
  if ((e.kind === 'unary' || e.kind === 'convert') && port === 'left') return e.value;
  if (e.kind === 'concat' && /^part:[0-9]+$/.test(port)) {
    const part = e.parts[Number(port.slice(5))];
    if (!part) throw new Error('Invalid concatenation socket.');
    return part;
  }
  if (!['left', 'right', 'select'].includes(port)) throw new Error('Invalid input socket.');
  if (e.kind === 'op' && (port === 'left' || port === 'right'))
    return port === 'left' ? e.left : e.right;
  if (e.kind === 'mux')
    return port === 'select' ? e.condition : port === 'left' ? e.truthy : e.falsy;
  throw new Error('That component has no matching input socket.');
}
function references(e: Expr, name: string): boolean {
  if (e.kind === 'convert' || e.kind === 'unary') return references(e.value, name);
  if (e.kind === 'ref' || e.kind === 'slice') return e.value === name;
  if (e.kind === 'concat') return e.parts.some((p) => references(p, name));
  if (e.kind === 'op') return references(e.left, name) || references(e.right, name);
  if (e.kind === 'mux') return [e.condition, e.truthy, e.falsy].some((c) => references(c, name));
  return false;
}
/** Every operation is planned from AST spans. No formatting pass or whole-file rewrite is used. */
export function sourceActionEdits(source: string, action: SourceAction): Edit[] {
  if (isVhdl(source)) return vhdlActionEdits(source, action);
  if (!action || typeof action !== 'object') throw new Error('Invalid construction action.');
  const ast = parse(source, action.scope),
    graph = project(ast);
  if (action.kind === 'create') return checked(source, create(source, ast, action));
  if (action.kind === 'paste') return paste(source, ast, action.items);
  if (action.kind === 'import') {
    if (
      !Array.isArray(action.definitions) ||
      !action.definitions.length ||
      action.definitions.length > 64 ||
      action.definitions.some((s) => typeof s !== 'string') ||
      action.definitions.join('').length > 500_000
    )
      throw new Error('Invalid module import.');
    const imported = parse(action.definitions.join('\n'));
    if (imported.language === 'vhdl')
      throw new Error(
        'Import entities into a VHDL document. Mixed-language elaboration is unsupported.',
      );
    for (const name of Object.keys(imported.library))
      if (ast.library[name])
        throw new Error(`Module ${name} already exists. Rename it before importing.`);
    const newline = source.includes('\r\n') ? '\r\n' : '\n';
    return checked(source, [
      {
        start: source.length,
        end: source.length,
        text: newline + action.definitions.join(newline + newline) + newline,
      },
    ]);
  }
  if (action.kind === 'module') {
    assertIdentifier(action.name);
    if (ast.library[action.name]) throw new Error('Module name already exists.');
    const newline = source.includes('\r\n') ? '\r\n' : '\n';
    return checked(source, [
      {
        start: source.length,
        end: source.length,
        text: `${newline}module ${action.name}();${newline}endmodule${newline}`,
      },
    ]);
  }
  const target = graph.nodes.find((n) => n.key === action.target);
  if (!target) throw new Error('The target no longer exists. Reopen the module.');
  if (action.kind === 'change') return [graphPatch(source, graph, target.id, action.change)];
  const expr = expressions(ast).get(target.expressionKey ?? target.key);
  const driver = ast.assigns.find(
    (a) => a.target === (netKind(target) ? target.label : target.assignmentTarget),
  );
  if (action.kind === 'connect') {
    const from = graph.nodes.find((n) => n.key === action.source);
    if (!from?.sourceNet)
      throw new Error(
        'Connect from an input, named wire, or component result. Inner expressions must first have a named result.',
      );
    if (
      !['left', 'right', 'select'].includes(action.port) &&
      !/^part:[0-9]+$/.test(action.port) &&
      !/^port:[A-Za-z_][A-Za-z0-9_$]*$/.test(action.port)
    )
      throw new Error('Invalid input socket.');
    const replacement = from.sourceNet;
    if (target.kind === 'register' || driver?.events)
      return checked(
        source,
        registerEdits(ast, driver?.target ?? target.label, action.port, replacement).map((e) =>
          withoutComments(source, e),
        ),
      );
    if (target.kind === 'instance') {
      const inst = ast.instances.find((n) => n.name === target.label)!,
        port = inst.ports.find((p) => `port:${p.name}` === action.port);
      if (!port || !target.inputPorts?.some((p) => p.name === action.port))
        throw new Error('Choose an instance input port.');
      return checked(source, [
        withoutComments(source, { ...expressionSpan(port.expr), text: replacement }),
      ]);
    }
    if (netKind(target)) {
      if (driver?.structured) throw new Error('Rewire this procedural block in the HDL editor.');
      if (target.kind === 'input' || action.port !== 'left')
        throw new Error('Inputs cannot have drivers.');
      if (
        ast.instances.some((inst) =>
          inst.ports.some(
            (p) =>
              p.expr.kind === 'ref' &&
              p.expr.value === target.label &&
              ast.library[inst.module].nets.some(
                (n) => n.name === p.name && n.direction === 'output',
              ),
          ),
        )
      )
        throw new Error(
          'This signal is driven by an instance output. Edit that instance binding in source.',
        );
      if (driver)
        return checked(source, [
          withoutComments(
            source,
            /^if\b/.test(source.slice(driver.start))
              ? { start: driver.start, end: driver.end, text: `${driver.target} = ${replacement};` }
              : { ...expressionSpan(driver.expr), text: replacement },
          ),
        ]);
      return checked(source, [
        bodyInsertion(source, ast, [`assign ${target.label} = ${replacement};`]),
      ]);
    }
    if (!expr) throw new Error('Expression no longer exists.');
    if (expr.kind === 'slice' && action.port === 'left')
      return checked(source, [
        { start: expr.start, end: expr.start + expr.value.length, text: replacement },
      ]);
    if (
      expr.kind === 'mux' &&
      action.port === 'select' &&
      !ast.nets.some((n) => n.name === replacement && n.width === 1)
    )
      throw new Error('Mux selector connections require a scalar signal.');
    return checked(source, [
      withoutComments(source, { ...expressionSpan(operand(expr, action.port)), text: replacement }),
    ]);
  }
  if (action.kind === 'disconnect') {
    if (driver) requireIndependentDriver(ast, driver);
    if (!driver) throw new Error('This component has no named driver to disconnect.');
    return checked(source, [
      withoutComments(source, { start: driver.start, end: driver.end, text: '' }),
    ]);
  }
  if (action.kind === 'zero') {
    if (target.kind === 'register' || driver?.events) {
      if (action.port !== 'port:D' && action.port !== 'left')
        throw new Error('Only register data can be tied to zero.');
      return checked(
        source,
        registerEdits(ast, driver?.target ?? target.label, 'port:D', zero(target.width ?? 1)),
      );
    }
    if (driver?.structured) throw new Error('Edit this procedural block in HDL.');
    if (target.kind === 'instance') {
      const inst = ast.instances.find((i) => i.name === target.label)!,
        port = inst.ports.find((p) => `port:${p.name}` === action.port),
        definition = target.inputPorts?.find((p) => p.name === action.port);
      if (!port || !definition) throw new Error('Choose an instance input port.');
      return checked(source, [
        withoutComments(source, { ...expressionSpan(port.expr), text: zero(definition.width) }),
      ]);
    }
    if (!expr) throw new Error('Select an expression input or component to tie to zero.');
    const selected = action.port ? operand(expr, action.port) : expr;
    const key =
      action.port === 'select'
        ? 1
        : (target.inputPorts?.find((p) => p.name === action.port)?.width ??
          (action.port ? target.operandWidths?.[action.port === 'right' ? 1 : 0] : undefined) ??
          target.width ??
          1);
    return checked(source, [
      withoutComments(
        source,
        selected === driver?.expr && /^if\b/.test(source.slice(driver.start))
          ? { start: driver.start, end: driver.end, text: `${driver.target} = ${zero(key)};` }
          : { ...expressionSpan(selected), text: zero(key) },
      ),
    ]);
  }
  if (action.kind === 'remove') {
    if (target.kind === 'instance') {
      const inst = ast.instances.find((i) => i.name === target.label)!;
      return checked(source, [
        withoutComments(source, { start: inst.start, end: inst.end, text: '' }),
      ]);
    }
    const name = target.kind === 'wire' ? target.label : target.assignmentTarget;
    if (!name)
      throw new Error(
        'Ports are kept in the module interface. For an inner expression, use Replace with zero.',
      );
    const declaration = ast.nets.find((n) => n.name === name)!;
    if (driver) requireIndependentDriver(ast, driver);
    if (
      ast.assigns.some((a) => a.target !== name && references(a.expr, name)) ||
      ast.instances.some((i) => i.ports.some((p) => references(p.expr, name)))
    )
      throw new Error(
        'This result is still wired to another component. Disconnect its consumers first, or explicitly disconnect its driver.',
      );
    const edits: Edit[] = [];
    if (driver)
      edits.push(withoutComments(source, { start: driver.start, end: driver.end, text: '' }));
    if (declaration.direction === 'wire') {
      if (
        declaration.declarationStart === undefined ||
        ast.nets.filter((n) => n.declarationStart === declaration.declarationStart).length !== 1
      )
        throw new Error(
          'This wire shares a declaration. Split the declaration in VS Code before deleting it.',
        );
      edits.push(
        withoutComments(source, {
          start: declaration.declarationStart,
          end: declaration.declarationEnd!,
          text: '',
        }),
      );
    }
    if (!edits.length) throw new Error('There is no removable component here.');
    return checked(source, edits);
  }
  throw new Error('Unsupported construction action.');
}
function checked(source: string, edits: Edit[]) {
  const draft = new PatchDraft(source);
  draft.apply(edits);
  project(parse(draft.text));
  return edits;
}
export function planTransaction(source: string, actions: SourceAction[]): PatchDraft {
  if (!Array.isArray(actions) || !actions.length || actions.length > 100)
    throw new Error('Construction transactions require 1–100 supported actions.');
  const draft = new PatchDraft(source);
  for (const action of actions) draft.apply(sourceActionEdits(draft.text, action));
  return draft;
}
export function validateConstructionProof(source: string, edits: Edit[], actions: SourceAction[]) {
  const expected = planTransaction(source, actions).edits();
  const normalize = (list: Edit[]) =>
    [...list]
      .sort((a, b) => b.start - a.start)
      .map((e) => ({ start: e.start, end: e.end, text: e.text }));
  if (JSON.stringify(normalize(edits)) !== JSON.stringify(normalize(expected)))
    throw new Error('Construction patches do not match the independently replayed actions.');
}

/** In-app clipboard stores supported source expressions, never executable editor commands. */
export function copyComponents(
  source: string,
  graph: ReturnType<typeof project>,
  ids: string[],
): ClipboardItem[] {
  if (isVhdl(source)) return copyVhdl(source, graph, ids);
  if (!Array.isArray(ids) || !ids.length || ids.length > 50)
    throw new Error('Select 1–50 components to copy.');
  const ast = parse(source, graph.module),
    names = new Set<string>(),
    instances = new Set<string>(),
    ports = new Set<string>();
  for (const id of ids) {
    const node = graph.nodes.find((n) => n.id === id);
    if (!node) throw new Error('Selection no longer exists.');
    if (node.kind === 'instance') {
      instances.add(node.label);
      for (const output of node.outputPorts ?? []) names.add(output.signal);
    } else {
      const name =
        node.assignmentTarget ??
        (['input', 'wire', 'output'].includes(node.kind) ? node.label : undefined);
      if (!name)
        throw new Error(
          'Copy a named result, signal or instance. Nested expressions need their own named result.',
        );
      names.add(name);
      if (node.kind === 'input' || node.kind === 'output') ports.add(name);
    }
  }
  const items: ClipboardItem[] = [...names].map((name) => {
    const net = ast.nets.find((n) => n.name === name)!,
      driver = ast.assigns.find((a) => a.target === name);
    if (driver?.events)
      throw new Error(
        'Copy a clocked module instance to preserve register control, or create another register.',
      );
    return {
      name,
      width: net.width,
      signed: net.signed,
      ...(net.msb || net.lsb ? { netRange: `[${net.msb}:${net.lsb}]` } : {}),
      ...(net.direction === 'wire' || !ports.has(name) ? {} : { direction: net.direction }),
      ...(driver
        ? {
            expression: copyExpression(source, driver.expr, net.width, ast.nets),
          }
        : {}),
    };
  });
  for (const name of instances) {
    const inst = ast.instances.find((i) => i.name === name)!;
    items.push({
      name,
      width: 1,
      instance: {
        module: inst.module,
        ports: Object.fromEntries(
          inst.ports.map((p) => [
            p.name,
            source
              .slice(expressionSpan(p.expr).start, expressionSpan(p.expr).end)
              .replace(/\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g, ' '),
          ]),
        ),
      },
    });
  }
  if (items.length > 50) throw new Error('Selection and instance outputs exceed 50 copied items.');
  return items;
}
function paste(source: string, ast: Module, items: ClipboardItem[]): Edit[] {
  if (!Array.isArray(items) || !items.length || items.length > 50)
    throw new Error('Paste 1–50 clipboard items.');
  const occupied = new Set([...ast.nets.map((n) => n.name), ...ast.instances.map((i) => i.name)]),
    mapping = new Map<string, string>();
  for (const item of items) {
    if (item.language === 'vhdl')
      throw new Error('Clipboard expressions must come from the same HDL family.');
    assertIdentifier(item.name);
    if (
      mapping.has(item.name) ||
      !Number.isSafeInteger(item.width) ||
      item.width < 1 ||
      item.width > 4096
    )
      throw new Error('Invalid clipboard name or width.');
    let index = 1,
      name = `${item.name}_copy${index}`;
    while (occupied.has(name)) name = `${item.name}_copy${++index}`;
    assertIdentifier(name);
    mapping.set(item.name, name);
    occupied.add(name);
  }
  const rename = (text: string) => {
    if (typeof text !== 'string' || text.length > 32768 || /[.;]|\/\/|\/\*/.test(text))
      throw new Error('Clipboard expressions cannot contain statements or comments.');
    return text.replace(
      /\$(?:signed|unsigned)\b|[0-9][0-9_]*'[bBoOdDhH][0-9a-fA-F_]+|[a-zA-Z_][a-zA-Z0-9_$]*/g,
      (token) => mapping.get(token) ?? token,
    );
  };
  const draft = new PatchDraft(source);
  for (const item of items.filter((i) => i.direction)) {
    if (item.direction !== 'input' && item.direction !== 'output')
      throw new Error('Invalid clipboard port.');
    draft.apply(
      create(draft.text, parse(draft.text, ast.name), {
        kind: 'create',
        component: item.direction!,
        name: mapping.get(item.name)!,
        width: item.width,
        netRange: item.netRange,
        signed: item.signed,
      }),
    );
  }
  const lines = items
    .filter((i) => !i.direction && !i.instance)
    .map((i) => {
      if (i.signed !== undefined && typeof i.signed !== 'boolean')
        throw new Error('Invalid signed clipboard declaration.');
      return `wire ${i.signed ? 'signed ' : ''}${declarationWidth(i.width, i.netRange)}${mapping.get(i.name)};`;
    });
  for (const item of items) {
    if (item.expression !== undefined) {
      if (item.instance || item.direction === 'input') throw new Error('Invalid clipboard driver.');
      lines.push(`assign ${mapping.get(item.name)} = ${rename(item.expression)};`);
    }
    if (item.instance) {
      assertIdentifier(item.instance.module);
      const ports = Object.entries(item.instance.ports).map(([name, expression]) => {
        assertIdentifier(name);
        return `.${name}(${rename(expression)})`;
      });
      lines.push(`${item.instance.module} ${mapping.get(item.name)} (${ports.join(', ')});`);
    }
  }
  if (lines.length) draft.apply([bodyInsertion(draft.text, parse(draft.text, ast.name), lines)]);
  // Every fragment is confined to one expression; the document parser validates names and drivers.
  project(parse(draft.text, ast.name));
  return draft.edits();
}

function copyExpression(source: string, e: Expr, contextWidth: number, nets: Net[]): string {
  const text = source
    .slice(expressionSpan(e).start, expressionSpan(e).end)
    .replace(/\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g, ' ');
  if (!text.includes(';')) return text;
  // A procedural if assigns each arm independently. Freeze each arm's width
  // and type before expressing it as a ternary; bitwise OR preserves x masks.
  const arm = (e: Expr) =>
    `$unsigned((${render(e)}) | ${expressionSigned(e) ? `$signed(${contextWidth}'d0)` : `${contextWidth}'d0`})`;
  const branch = (owner: Extract<Expr, { kind: 'mux' }>, value: Expr) =>
    owner.procedural && (expressionSigned(owner.truthy) || expressionSigned(owner.falsy))
      ? arm(value)
      : render(value);
  const render = (e: Expr): string => {
    if (e.kind === 'ref' || e.kind === 'literal') return e.value;
    if (e.kind === 'slice') return e.value + '[' + (e.bit ? e.msb : e.msb + ':' + e.lsb) + ']';
    if (e.kind === 'concat') {
      const text = e.parts.map(render).join(', ');
      return e.repeat ? '{' + e.repeat + '{' + text + '}}' : '{' + text + '}';
    }
    if (e.kind === 'mux')
      return (
        '(' +
        (e.procedural ? '(((' + render(e.condition) + ") != 0) === 1'b1)" : render(e.condition)) +
        ' ? ' +
        branch(e, e.truthy) +
        ' : ' +
        branch(e, e.falsy) +
        ')'
      );
    if (e.kind === 'unary') return '(' + e.op + render(e.value) + ')';
    if (e.kind === 'convert' && e.conversion === 'resize')
      return (
        '$' +
        (e.signed ? 'signed' : 'unsigned') +
        '(' +
        e.resultWidth +
        "'(" +
        render(e.value) +
        '))'
      );
    if (e.kind === 'convert' && ['signed', 'unsigned'].includes(e.conversion))
      return '$' + e.conversion + '(' + render(e.value) + ')';
    if (e.kind === 'op' && e.caseLabels) {
      // Every case arm shares the widest selector/label context, including
      // arithmetic inside the selector. Preserve that context when copying.
      const width = Math.max(
        expressionWidth(e.left, nets),
        ...e.caseLabels.map((label) => expressionWidth(label, nets)),
      );
      const signed = expressionSigned(e.left) && e.caseLabels.every(expressionSigned);
      const cast = (value: Expr) =>
        '$' + (signed ? 'signed' : 'unsigned') + '(' + width + "'(" + render(value) + '))';
      return '(' + cast(e.left) + ' === ' + cast(e.right) + ')';
    }
    if (e.kind === 'op') return '(' + render(e.left) + ' ' + e.op + ' ' + render(e.right) + ')';
    throw new Error('Unsupported cross-language expression.');
  };
  return render(e);
}
