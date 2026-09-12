import nop from './nop.js';
import move from './move.js';
import loadimm from './loadimm.js';
import loadtrue from './loadtrue.js';
import loadfalse from './loadfalse.js';
import loadnil from './loadnil.js';
import loadnil_range from './loadnil_range.js';
import getglobal from './getglobal.js';
import getglobal_select from './getglobal_select.js';
import setglobal from './setglobal.js';
import getupval from './getupval.js';
import newtable from './newtable.js';
import gettable from './gettable.js';
import settable from './settable.js';
import self from './self.js';
import setlist from './setlist.js';
import len from './len.js';
import not from './not.js';
import unm from './unm.js';
import binary from './binary.js';
import add_rr from './add_rr.js';
import sub_rr from './sub_rr.js';
import mul_rr from './mul_rr.js';
import div_rr from './div_rr.js';
import move_select from './move_select.js';
import move_pair from './move_pair.js';
import jump from './jump.js';
import jump_if_false from './jump_if_false.js';
import forprep from './forprep.js';
import forloop from './forloop.js';
import tforloop from './tforloop.js';
import call from './call.js';
import tailcall from './tailcall.js';
import ret from './return.js';
import vararg from './vararg.js';
import closure from './closure.js';
import close from './close.js';
import vmseed_const from './vmseed_const.js';
import vmseed_stream from './vmseed_stream.js';
import dispatch_wrapper from './dispatch_wrapper.js';
import inline from './inline.js';

export const OPCODES = Object.freeze({
  nop, move, loadimm, loadtrue, loadfalse, loadnil, loadnil_range,
  getglobal, getglobal_select, setglobal, getupval, newtable, gettable,
  settable, self, setlist, len, not, unm, binary, add_rr, sub_rr, mul_rr,
  div_rr, move_select, move_pair, jump, jump_if_false, forprep, forloop,
  tforloop, call, tailcall, return:ret, vararg, closure, close,
  vmseed_const, vmseed_stream, dispatch_wrapper, inline
});
