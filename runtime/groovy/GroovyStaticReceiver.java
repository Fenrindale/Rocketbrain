import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.regex.Pattern;
import org.codehaus.groovy.ast.ClassCodeVisitorSupport;
import org.codehaus.groovy.ast.CodeVisitorSupport;
import org.codehaus.groovy.ast.MethodNode;
import org.codehaus.groovy.ast.ModuleNode;
import org.codehaus.groovy.ast.DynamicVariable;
import org.codehaus.groovy.ast.expr.ArgumentListExpression;
import org.codehaus.groovy.ast.expr.AttributeExpression;
import org.codehaus.groovy.ast.expr.ConstructorCallExpression;
import org.codehaus.groovy.ast.expr.DeclarationExpression;
import org.codehaus.groovy.ast.expr.Expression;
import org.codehaus.groovy.ast.expr.MethodCallExpression;
import org.codehaus.groovy.ast.expr.PropertyExpression;
import org.codehaus.groovy.ast.expr.VariableExpression;
import org.codehaus.groovy.ast.stmt.BlockStatement;
import org.codehaus.groovy.ast.stmt.ExpressionStatement;
import org.codehaus.groovy.ast.stmt.ReturnStatement;
import org.codehaus.groovy.ast.stmt.Statement;
import org.codehaus.groovy.classgen.VariableScopeVisitor;
import org.codehaus.groovy.control.CompilationFailedException;
import org.codehaus.groovy.control.SourceUnit;

/** Parses the editor buffer and binds its lexical variables using only the pinned Groovy compiler. */
public final class GroovyStaticReceiver {
    private static final Pattern QUALIFIED = Pattern.compile("[A-Za-z_$][A-Za-z0-9_$]*(?:\\.[A-Za-z_$][A-Za-z0-9_$]*)+");
    private static final Pattern IDENTIFIER = Pattern.compile("[A-Za-z_$][A-Za-z0-9_$]{0,127}");
    private static final Set<String> DISPATCH_HOOKS = Set.of("metaClass", "getMetaClass", "setMetaClass",
        "metaClassRegistry", "getMetaClassRegistry", "invokeMethod", "methodMissing", "propertyMissing",
        "getProperty", "setProperty", "mixin", "use");

    public static void main(String[] arguments) throws Exception {
        if (arguments.length != 3) throw new IllegalArgumentException("Invalid owned Groovy receiver request.");
        String source = Files.readString(Path.of(arguments[0]), StandardCharsets.UTF_8);
        String marker = arguments[1];
        int offset = Integer.parseInt(arguments[2]);
        if (source.length() > 65536 + 80 || !marker.matches("__rbGroovyMember[0-9a-f]{32}") ||
                offset < 1 || !source.startsWith(marker, offset)) {
            throw new IllegalArgumentException("Invalid bounded Groovy receiver selection.");
        }
        try {
            inspect(source, marker, offset);
        } catch (CompilationFailedException | IllegalArgumentException error) {
            System.out.println("UNSUPPORTED");
        }
    }

    private static void inspect(String source, String marker, int offset) throws Exception {
        SourceUnit unit = SourceUnit.create("RocketbrainSelection.groovy", source);
        unit.parse();
        unit.completePhase();
        unit.nextPhase();
        unit.convert();
        var module = unit.getAST();
        if (!module.getStarImports().isEmpty() || !module.getStaticStarImports().isEmpty() ||
                !module.getStaticImports().isEmpty()) {
            System.out.println("UNSUPPORTED");
            return;
        }
        for (var owner : module.getClasses()) new VariableScopeVisitor(unit).visitClass(owner);
        List<String> found = new ArrayList<>();
        var visitor = new ClassCodeVisitorSupport() {
            private MethodNode method;

            @Override protected SourceUnit getSourceUnit() { return unit; }

            @Override public void visitMethod(MethodNode node) {
                var prior = method;
                method = node;
                try { super.visitMethod(node); }
                finally { method = prior; }
            }

            @Override public void visitPropertyExpression(PropertyExpression node) {
                if (!(node instanceof AttributeExpression) && !node.isSafe() && !node.isSpreadSafe()) {
                    capture(node, node.getObjectExpression(), node.getProperty(), node.getPropertyAsString());
                }
                super.visitPropertyExpression(node);
            }

            @Override public void visitMethodCallExpression(MethodCallExpression node) {
                if (!node.isImplicitThis() && !node.isSafe() && !node.isSpreadSafe()) {
                    capture(node, node.getObjectExpression(), node.getMethod(), node.getMethodAsString());
                }
                super.visitMethodCallExpression(node);
            }

            private void capture(Expression selected, Expression receiver, Expression member, String name) {
                if (!marker.equals(name) || offsetAt(source, member.getLineNumber(), member.getColumnNumber()) != offset ||
                        !(receiver instanceof VariableExpression variable)) return;
                if (!(variable.getAccessedVariable() instanceof VariableExpression binding)) return;
                int start = offsetAt(source, binding.getLineNumber(), binding.getColumnNumber());
                if (start < 0 || start >= offset || !source.startsWith(binding.getName(), start)) return;
                String declaration = "\t" + start + "\t" + (start + binding.getName().length());
                if (binding.isDynamicTyped()) {
                    var inferred = inferReceiver(unit, module, method, selected, variable, binding);
                    if (inferred != null) found.add(inferred.owner() + declaration + "\t" + inferred.strategy());
                    return;
                }
                var type = binding.getOriginType();
                if (type.isArray() || type.getGenericsTypes() != null && type.getGenericsTypes().length > 0) return;
                String qualified = qualifiedOwner(module, type.getName());
                if (qualified != null) found.add(qualified + declaration + "\texplicit");
            }
        };
        for (var owner : module.getClasses()) visitor.visitClass(owner);
        if (found.size() != 1) System.out.println("UNSUPPORTED");
        else System.out.println("RECEIVER\t" + found.getFirst());
    }

    private record Inference(String owner, String strategy) {}

    private static Inference inferReceiver(SourceUnit unit, ModuleNode module, MethodNode method, Expression selected,
                                            VariableExpression receiver, VariableExpression binding) {
        if (method == null || !(method.getCode() instanceof BlockStatement body) ||
                !method.getAnnotations().isEmpty() || method.getDeclaringClass() == null ||
                !method.getDeclaringClass().getAnnotations().isEmpty() || !directScriptEntry(module, method, body)) return null;
        var statements = body.getStatements();
        if (statements.size() < 2 || !(expression(statements.getFirst()) instanceof DeclarationExpression declaration) ||
                declaration.isMultipleAssignmentDeclaration() || declaration.getLeftExpression() != binding ||
                expression(statements.get(1)) != selected || !onlyReceiverUse(body, binding, receiver) ||
                hasDynamicDispatchHooks(unit, module)) return null;
        var initializer = declaration.getRightExpression();
        if (initializer instanceof ConstructorCallExpression constructor && !constructor.isSpecialCall() &&
                !constructor.isUsingAnonymousInnerClass() && noArguments(constructor.getArguments()) &&
                !constructor.getType().isArray() && constructor.getType().getGenericsTypes() == null) {
            String owner = qualifiedOwner(module, constructor.getType().getName());
            if (owner != null) return new Inference(owner, "constructor");
        }
        if (initializer instanceof MethodCallExpression factory && !factory.isImplicitThis() && !factory.isSafe() &&
                !factory.isSpreadSafe() && noArguments(factory.getArguments()) &&
                factory.getObjectExpression() instanceof VariableExpression name &&
                name.getAccessedVariable() instanceof DynamicVariable && factory.getMethodAsString() != null &&
                IDENTIFIER.matcher(factory.getMethodAsString()).matches()) {
            String owner = qualifiedOwner(module, name.getName());
            if (owner != null) return new Inference(owner, "factory:" + factory.getMethodAsString());
        }
        return null;
    }

    private static boolean directScriptEntry(ModuleNode module, MethodNode method, BlockStatement body) {
        if (!method.getDeclaringClass().isScript() || module.getStatementBlock() == body) return true;
        var statements = module.getStatementBlock().getStatements();
        if (statements.isEmpty()) return true;
        return statements.size() == 1 && expression(statements.getFirst()) instanceof MethodCallExpression call &&
            call.isImplicitThis() && !call.isSafe() && !call.isSpreadSafe() && noArguments(call.getArguments()) &&
            method.getName().equals(call.getMethodAsString()) && method.getParameters().length == 0;
    }

    private static boolean onlyReceiverUse(BlockStatement body, VariableExpression binding, VariableExpression receiver) {
        var visitor = new CodeVisitorSupport() {
            int references;
            @Override public void visitVariableExpression(VariableExpression variable) {
                if (variable != binding && variable != receiver && variable.getAccessedVariable() == binding) references++;
            }
        };
        body.visit(visitor);
        return visitor.references == 0;
    }

    private static boolean hasDynamicDispatchHooks(SourceUnit unit, ModuleNode module) {
        var visitor = new ClassCodeVisitorSupport() {
            boolean found;
            @Override protected SourceUnit getSourceUnit() { return unit; }
            @Override public void visitMethod(MethodNode method) {
                if (DISPATCH_HOOKS.contains(method.getName())) found = true;
                super.visitMethod(method);
            }
            @Override public void visitPropertyExpression(PropertyExpression property) {
                String name = property.getPropertyAsString();
                if (name == null || DISPATCH_HOOKS.contains(name)) found = true;
                super.visitPropertyExpression(property);
            }
            @Override public void visitMethodCallExpression(MethodCallExpression call) {
                String name = call.getMethodAsString();
                if (name == null || DISPATCH_HOOKS.contains(name)) found = true;
                super.visitMethodCallExpression(call);
            }
        };
        for (var owner : module.getClasses()) visitor.visitClass(owner);
        return visitor.found;
    }

    private static Expression expression(Statement statement) {
        if (statement instanceof ExpressionStatement value) return value.getExpression();
        if (statement instanceof ReturnStatement value) return value.getExpression();
        return null;
    }

    private static boolean noArguments(Expression arguments) {
        return arguments instanceof ArgumentListExpression values && values.getExpressions().isEmpty();
    }

    private static String qualifiedOwner(ModuleNode module, String spelling) {
        var imports = module.getImports().stream().filter(entry -> spelling.equals(entry.getAlias())).toList();
        String qualified = imports.size() == 1 ? imports.getFirst().getType().getName() : imports.isEmpty() ? spelling : "";
        if (!QUALIFIED.matcher(qualified).matches() || module.getClasses().stream().anyMatch(owner -> owner.getName().equals(qualified) ||
                owner.getNameWithoutPackage().equals(spelling))) return null;
        return qualified;
    }

    private static int offsetAt(String source, int line, int column) {
        if (line < 1 || column < 1) return -1;
        int start = 0;
        for (int row = 1; row < line; row++) {
            start = source.indexOf('\n', start) + 1;
            if (start == 0) return -1;
        }
        int offset = start + column - 1;
        return offset <= source.length() ? offset : -1;
    }
}
