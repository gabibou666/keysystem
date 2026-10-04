-- Compatibility gate using the pinned engine's parser and AST visitor.
-- This script checks source structure; it never evaluates the uploaded code.
package.path = arg[1] .. "/src/?.lua;" .. package.path
local Parser = require("prometheus.parser")
local visit = require("prometheus.visitast")
local handle = assert(io.open(arg[2], "rb"))
local source = handle:read("*a")
handle:close()
local ast = Parser:new({luaVersion="Lua51"}):parse(source)
local literals = {StringExpression=true, NumberExpression=true, BooleanExpression=true, NilExpression=true, VarargExpression=true, FunctionLiteralExpression=true}
local function simpleArgument(node)
  if literals[node.kind] then return true end
  if node.kind == "VariableExpression" then return not node.scope.isGlobal end
  if node.kind == "TableConstructorExpression" then
    for _, entry in ipairs(node.entries) do
      if not simpleArgument(entry.value) or entry.key and not simpleArgument(entry.key) then return false end
    end
    return true
  end
  -- Only a unary negative numeric literal is guaranteed free of metamethods.
  if node.kind == "NegateExpression" and node.rhs.kind == "NumberExpression" then return true end
  return false
end
visit(ast, function(node)
  -- Upstream Vmify 0.2.11.1 does not preserve generalized table iteration,
  -- false iterator keys, or iterator results beyond two values. Reject all
  -- generic iterator loops in Strong rather than guessing runtime key types.
  if node.kind == "ForInStatement" then os.exit(42) end
  -- Lua 5.1 captures obj.method before arguments; Luau resolves it afterwards.
  -- Calls, table indexing, globals and operators may mutate that method via
  -- user code/metamethods. Preserve those native semantics in Standard only.
  if node.kind == "PassSelfFunctionCallExpression" or node.kind == "PassSelfFunctionCallStatement" then
    for _, argument in ipairs(node.args) do
      if not simpleArgument(argument) then os.exit(42) end
    end
  end
end)
