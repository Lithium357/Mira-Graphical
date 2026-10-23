// SPDX-License-Identifier: GPL-3.0-only
import {
  operators,
  type SourceAction,
  type Edit,
  type InputPort,
  type CreateComponent,
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
} from './index.js';
import { literalWidth } from './literals.js';
import { PatchDraft } from './patches.js';
const zero = (width: number) => `${width}'d0`;
const netKind = (node: Node) => ['input', 'output', 'wire'].includes(node.kind);
function withoutComments(source: string, edit: Edit): Edit {
  if (/\/\/|\/\*/.test(source.slice(edit.start, edit.end)))
    throw new Error(
      'This structural edit would remove a comment. Edit that region in VS Code instead.',
    );
  return edit;
}
function bodyInsertion(source: string, ast: Module, statements: string[]): Edit {
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
  if (ast.nets.some((n) => n.name === action.name))
    throw new Error('A signal with that name already exists.');
  if (!Number.isSafeInteger(action.width) || action.width < 1 || action.width > 4096)
    throw new Error('Choose a width between 1 and 4096 bits.');
  const width = action.width === 1 ? '' : `[${action.width - 1}:0] `;
  if (action.component === 'input' || action.component === 'output') {
    const declaration = `${action.component} wire ${width}${action.name}`;
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
  const statements = [`wire ${width}${action.name};`];
  let expression: string | undefined;
  if (action.component === 'operation') {
    if (!operators.includes(action.operator!)) throw new Error('Choose a supported operation.');
    expression = `${zero(action.width)} ${action.operator} ${zero(action.width)}`;
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
  } else if (action.component !== 'wire') throw new Error('Unsupported component type.');
  if (expression) statements.push(`assign ${action.name} = ${expression};`);
  return [bodyInsertion(source, ast, statements)];
}
function operand(e: Expr, port: InputPort): Expr {
  if (!['left', 'right', 'select'].includes(port)) throw new Error('Invalid input socket.');
  if (e.kind === 'op' && (port === 'left' || port === 'right'))
    return port === 'left' ? e.left : e.right;
  if (e.kind === 'mux')
    return port === 'select' ? e.condition : port === 'left' ? e.truthy : e.falsy;
  throw new Error('That component has no matching input socket.');
}
function references(e: Expr, name: string): boolean {
  if (e.kind === 'ref' || e.kind === 'slice') return e.value === name;
  if (e.kind === 'op') return references(e.left, name) || references(e.right, name);
  if (e.kind === 'mux') return [e.condition, e.truthy, e.falsy].some((c) => references(c, name));
  return false;
}
/** Every operation is planned from AST spans. No formatting pass or whole-file rewrite is used. */
export function sourceActionEdits(source: string, action: SourceAction): Edit[] {
  if (!action || typeof action !== 'object') throw new Error('Invalid construction action.');
  const ast = parse(source),
    graph = project(ast);
  if (action.kind === 'create') return checked(source, create(source, ast, action));
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
    if (!['left', 'right', 'select'].includes(action.port))
      throw new Error('Invalid input socket.');
    const replacement = from.sourceNet;
    if (netKind(target)) {
      if (target.kind === 'input' || action.port !== 'left')
        throw new Error('Inputs cannot have drivers.');
      if (driver)
        return checked(source, [
          withoutComments(source, { ...expressionSpan(driver.expr), text: replacement }),
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
    if (!driver) throw new Error('This component has no named driver to disconnect.');
    return checked(source, [
      withoutComments(source, { start: driver.start, end: driver.end, text: '' }),
    ]);
  }
  if (action.kind === 'zero') {
    if (!expr) throw new Error('Select an expression input or component to tie to zero.');
    const selected = action.port ? operand(expr, action.port) : expr;
    const key = action.port === 'select' ? 1 : (target.width ?? 1);
    return checked(source, [
      withoutComments(source, { ...expressionSpan(selected), text: zero(key) }),
    ]);
  }
  if (action.kind === 'remove') {
    const name = target.kind === 'wire' ? target.label : target.assignmentTarget;
    if (!name)
      throw new Error(
        'Ports are kept in the module interface. For an inner expression, use Replace with zero.',
      );
    const declaration = ast.nets.find((n) => n.name === name)!;
    if (ast.assigns.some((a) => a.target !== name && references(a.expr, name)))
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
