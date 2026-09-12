export default function leakedDispatchWrapper(i) {
  throw new Error(`dispatch_wrapper leaked past VM expansion at pc ${i.pc}`);
}
