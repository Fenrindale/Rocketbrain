import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Pattern;
import org.codehaus.groovy.ast.ASTNode;
import org.codehaus.groovy.ast.ClassCodeVisitorSupport;
import org.codehaus.groovy.ast.expr.AttributeExpression;
import org.codehaus.groovy.ast.expr.Expression;
import org.codehaus.groovy.ast.expr.MethodCallExpression;
import org.codehaus.groovy.ast.expr.PropertyExpression;
import org.codehaus.groovy.ast.expr.VariableExpression;
import org.codehaus.groovy.classgen.VariableScopeVisitor;
import org.codehaus.groovy.control.CompilationFailedException;
import org.codehaus.groovy.control.SourceUnit;

/** Parses the editor buffer and binds its lexical variables using only the pinned Groovy compiler. */
public final class GroovyStaticReceiver {
    private static final Pattern QUALIFIED = Pattern.compile("[A-Za-z_$][A-Za-z0-9_$]*(?:\\.[A-Za-z_$][A-Za-z0-9_$]*)+");

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
        List<String> found = new ArrayList<>();
        var visitor = new ClassCodeVisitorSupport() {
            @Override protected SourceUnit getSourceUnit() { return unit; }

            @Override public void visitPropertyExpression(PropertyExpression node) {
                if (!(node instanceof AttributeExpression) && !node.isSafe() && !node.isSpreadSafe()) {
                    capture(node.getObjectExpression(), node.getProperty(), node.getPropertyAsString());
                }
                super.visitPropertyExpression(node);
            }

            @Override public void visitMethodCallExpression(MethodCallExpression node) {
                if (!node.isImplicitThis() && !node.isSafe() && !node.isSpreadSafe()) {
                    capture(node.getObjectExpression(), node.getMethod(), node.getMethodAsString());
                }
                super.visitMethodCallExpression(node);
            }

            private void capture(Expression receiver, Expression member, String name) {
                if (!marker.equals(name) || offsetAt(source, member.getLineNumber(), member.getColumnNumber()) != offset ||
                        !(receiver instanceof VariableExpression variable)) return;
                var binding = variable.getAccessedVariable();
                if (!(binding instanceof VariableExpression) || binding.isDynamicTyped()) return;
                var declaration = (ASTNode) binding;
                var type = binding.getOriginType();
                if (type.isArray() || type.getGenericsTypes() != null && type.getGenericsTypes().length > 0) return;
                String spelling = type.getName();
                var imports = module.getImports().stream().filter(entry -> spelling.equals(entry.getAlias())).toList();
                String qualified = imports.size() == 1 ? imports.getFirst().getType().getName() : imports.isEmpty() ? spelling : "";
                if (!QUALIFIED.matcher(qualified).matches() ||
                        module.getClasses().stream().anyMatch(owner -> owner.getName().equals(qualified) ||
                            owner.getNameWithoutPackage().equals(spelling))) return;
                int start = offsetAt(source, declaration.getLineNumber(), declaration.getColumnNumber());
                if (start < 0 || start >= offset || !source.startsWith(binding.getName(), start)) return;
                found.add(qualified + "\t" + start + "\t" + (start + binding.getName().length()));
            }
        };
        for (var owner : module.getClasses()) {
            new VariableScopeVisitor(unit).visitClass(owner);
            visitor.visitClass(owner);
        }
        if (found.size() != 1) System.out.println("UNSUPPORTED");
        else System.out.println("RECEIVER\t" + found.getFirst());
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
