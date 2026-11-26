package rocketbrain.signature;

import java.util.*;
import javax.lang.model.element.*;
import javax.lang.model.type.*;
import javax.lang.model.util.Types;
import com.sun.source.tree.*;
import com.sun.source.util.*;
import static rocketbrain.signature.SignatureInspector.object;

/** Attribution for return-type-only changes to a private Java declaration. */
final class SignatureReturn {
    private static boolean plainReference(TypeMirror type) {
        return type instanceof DeclaredType declared && type.getKind() == TypeKind.DECLARED &&
            declared.asElement() instanceof TypeElement element && element.getTypeParameters().isEmpty() &&
            declared.getTypeArguments().isEmpty();
    }

    static Map<String,Object> declaration(ExecutableElement method, MethodTree tree, TreePath path, Trees trees, Types types) {
        if (!method.getModifiers().contains(Modifier.PRIVATE) || method.isVarArgs() ||
                !method.getTypeParameters().isEmpty() || !plainReference(method.getReturnType()) ||
                tree.getReturnType() == null || tree.getBody() == null) return Map.of();
        var unit = path.getCompilationUnit();
        var positions = trees.getSourcePositions();
        long start = positions.getStartPosition(unit, tree.getReturnType()), end = positions.getEndPosition(unit, tree.getReturnType());
        if (start < 0 || end <= start) return Map.of();

        var expressions = new ArrayList<Map<String,Object>>();
        boolean[] unsupported = {false};
        new TreePathScanner<Void,Void>() {
            @Override public Void visitClass(ClassTree node, Void unused) { return null; }
            @Override public Void visitLambdaExpression(LambdaExpressionTree node, Void unused) { return null; }
            @Override public Void visitReturn(ReturnTree node, Void unused) {
                var expression = node.getExpression();
                if (expression == null || expressions.size() >= 40) {
                    unsupported[0] = true;
                    return null;
                }
                var expressionPath = new TreePath(getCurrentPath(), expression);
                TypeMirror type = trees.getTypeMirror(expressionPath);
                if (type == null || !(plainReference(type) || type.getKind() == TypeKind.NULL)) {
                    unsupported[0] = true;
                    return null;
                }
                if (expression instanceof IdentifierTree && trees.getElement(expressionPath) instanceof VariableElement value) {
                    expressions.add(object("kind", value.getKind().toString(), "name", value.getSimpleName().toString(),
                        "type", type.toString()));
                } else if (expression.getKind() == Tree.Kind.STRING_LITERAL || expression.getKind() == Tree.Kind.NULL_LITERAL) {
                    expressions.add(object("kind", expression.getKind().toString(), "type", type.toString()));
                } else {
                    unsupported[0] = true;
                }
                return null;
            }
        }.scan(new TreePath(path, tree.getBody()), null);
        if (unsupported[0] || expressions.isEmpty()) return Map.of();

        var supers = new LinkedHashSet<String>();
        var pending = new ArrayDeque<TypeMirror>(types.directSupertypes(method.getReturnType()));
        while (!pending.isEmpty()) {
            var next = pending.removeFirst();
            if (supers.add(next.toString())) {
                if (supers.size() > 80 || pending.size() > 160) return Map.of();
                pending.addAll(types.directSupertypes(next));
            }
        }
        return object("start", start, "end", end, "expressions", expressions, "supertypes", supers);
    }

    static Map<String,Object> consumer(Tree call, TreePath path, Trees trees, String text) {
        TreePath parent = path.getParentPath();
        if (parent == null) return Map.of();
        var node = parent.getLeaf();
        if (node instanceof ExpressionStatementTree statement && statement.getExpression() == call) {
            return object("kind", "discarded");
        }
        if (node instanceof VariableTree variable && variable.getInitializer() == call && variable.getType() != null &&
                trees.getElement(parent) instanceof VariableElement declared && declared.getKind() == ElementKind.LOCAL_VARIABLE &&
                plainReference(declared.asType())) {
            var positions = trees.getSourcePositions();
            long start = positions.getStartPosition(path.getCompilationUnit(), variable.getType());
            long end = positions.getEndPosition(path.getCompilationUnit(), variable.getType());
            if (start >= 0 && end > start && end <= text.length() && !text.substring((int) start, (int) end).strip().equals("var")) {
                return object("kind", "local", "type", declared.asType().toString(), "name", declared.getSimpleName().toString());
            }
        }
        if (node instanceof ReturnTree result && result.getExpression() == call) {
            for (TreePath owner = parent.getParentPath(); owner != null; owner = owner.getParentPath()) {
                if (owner.getLeaf() instanceof LambdaExpressionTree || owner.getLeaf() instanceof ClassTree) break;
                if (owner.getLeaf() instanceof MethodTree) {
                    if (trees.getElement(owner) instanceof ExecutableElement method && plainReference(method.getReturnType())) {
                        return object("kind", "return", "type", method.getReturnType().toString(),
                            "name", SignatureInspector.key(method));
                    }
                    break;
                }
            }
        }
        return Map.of();
    }
}
