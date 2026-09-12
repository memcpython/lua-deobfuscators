const httpFunction = require("./index");
const context = require("../testing/defaultContext");
test("Http trigger should return known text", async() => {
  const L_1 = {
    name: "Bill"
  };
  const L_2 = {
    query: L_1
  };
  await httpFunction(context, L_2);
  expect(context.log.mock.calls.length).toBe(1);
  expect(context.res.body).toEqual("Hello Bill");
});
