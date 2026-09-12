/**
 * IR vocabulary contracts.
 *
 * VM_IR_OPCODES are the canonical instructions produced by opcode lifting.
 * OPTIMIZER_IR_OPCODES are semantic instructions that optimization is allowed
 * to introduce before source recovery.  Every instruction in both sets MUST be
 * accepted by the compatibility emitter; otherwise an optimizer/source-mode
 * decision can turn a successfully lifted program into an emitter crash.
 */
export const VM_IR_OPCODES = Object.freeze([
  'nop','move','move_pair','clear_range','getglobal','setglobal','getupval',
  'newtable','gettable','settable','self','setlist','unary','binary','jump',
  'branch_false','forprep','forloop','tforloop','call','tailcall','return',
  'vararg','closure','close','vm_internal',
]);

export const OPTIMIZER_IR_OPCODES = Object.freeze([
  'identity_results','constant_call',
  'cell_new','cell_results','cell_get','cell_set','return_cell','return_literal',
]);

// Source structuring runs before the final per-bundle emitter decision.  These
// recovered semantic opcodes can therefore reach the compatibility fallback
// even though they are not produced by the VM lifters or optimizer modules.
export const FALLBACK_SEMANTIC_IR_OPCODES = Object.freeze([
  'logical_chain',
]);

export const LEGACY_IR_OPCODES = Object.freeze([
  ...VM_IR_OPCODES,
  ...OPTIMIZER_IR_OPCODES,
  ...FALLBACK_SEMANTIC_IR_OPCODES,
]);

export const SOURCE_ONLY_IR_OPCODES = Object.freeze([
  'source_local','source_local_multi','source_call','source_tailcall','source_method_call',
  'source_table_mutation','source_label','table_literal','table_record',
  'table_closure_record','table_vararg','vararg_setlist',
  'if','if_chain','while_true','repeat_until','numeric_for','generic_for',
]);


export const SOURCE_EMITTER_IR_OPCODES = Object.freeze([
  ...new Set([
    ...LEGACY_IR_OPCODES,
    ...SOURCE_ONLY_IR_OPCODES,
    'logical_chain',
  ]),
]);

export const SOURCE_EMITTER_IR_OPCODE_SET = new Set(SOURCE_EMITTER_IR_OPCODES);
