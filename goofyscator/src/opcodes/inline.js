export default function leakedInline(i) {
  throw new Error(`inline superinstruction leaked past VM expansion at pc ${i.pc}`);
}
