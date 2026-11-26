package rocketbrain.signature;

import com.sun.source.tree.ExpressionTree;
import com.sun.source.tree.LiteralTree;
import com.sun.source.tree.MethodInvocationTree;
import com.sun.source.tree.NewArrayTree;
import com.sun.source.tree.TypeCastTree;
import com.sun.source.util.SourcePositions;
import com.sun.source.util.TreePath;
import com.sun.source.util.Trees;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import javax.lang.model.element.ExecutableElement;
import javax.lang.model.element.TypeElement;
import javax.lang.model.type.TypeKind;
import javax.lang.model.util.Types;

import static rocketbrain.signature.SignatureInspector.object;

/** Evidence for a fixed-prefix reorder on an unchanged, non-generic varargs declaration. */
final class VarargsCalls {
    private VarargsCalls() { }

    static Map<String,Object> inspect(TreePath invocation, ExecutableElement method,
            List<? extends ExpressionTree> arguments, Trees trees, Types types, String source) {
        if (!(invocation.getLeaf() instanceof MethodInvocationTree call) || !method.isVarArgs() ||
                !method.getTypeParameters().isEmpty() || !(method.getEnclosingElement() instanceof TypeElement owner) || !owner.getTypeParameters().isEmpty()) {
            return Map.of();
        }
        int size = method.getParameters().size(), fixedCount = size - 1;
        if (arguments.size() < fixedCount || arguments.size() > 64 || size > 30) return Map.of();
        if (method.getParameters().getLast().asType().getKind() != TypeKind.ARRAY) return Map.of();

        var positions = trees.getSourcePositions();
        String selector = sourceText(invocation, call.getMethodSelect(), positions, source);
        if (selector == null) return Map.of();
        List<Map<String,Object>> observed = new ArrayList<>();
        var lastType = method.getParameters().getLast().asType();
        boolean passedArray = false;
        for (int index = 0; index < arguments.size(); index++) {
            ExpressionTree expression = arguments.get(index);
            TreePath argument = new TreePath(invocation, expression);
            var actual = trees.getTypeMirror(argument);
            String spelling = sourceText(invocation, expression, positions, source);
            if (actual == null || actual.getKind() == TypeKind.ERROR || spelling == null) return Map.of();
            if (index < fixedCount) {
                var formal = method.getParameters().get(index).asType();
                // Reordering may cross only inert values with no boxing, unboxing or checked casts.
                if (!SignatureInspector.safeArgument(invocation, expression, trees) ||
                        actual.getKind().isPrimitive() != formal.getKind().isPrimitive() || !types.isAssignable(actual, formal)) {
                    return Map.of();
                }
            } else {
                if (!standalone(invocation, expression, trees, types)) return Map.of();
                if (index == fixedCount && arguments.size() == size) passedArray = types.isAssignable(actual, lastType);
            }
            observed.add(object("source", spelling, "type", actual.toString()));
        }
        return object("mode", passedArray ? "fixed-array" : "spread", "fixedCount", fixedCount,
            "selector", selector, "arguments", observed);
    }

    private static boolean standalone(TreePath invocation, ExpressionTree expression, Trees trees, Types types) {
        if (SignatureInspector.safeArgument(invocation, expression, trees) || expression instanceof TypeCastTree ||
                expression instanceof NewArrayTree array && array.getType() != null) return true;
        if (!(expression instanceof MethodInvocationTree)) return false;
        TreePath path = new TreePath(invocation, expression);
        return trees.getElement(path) instanceof ExecutableElement method && method.getTypeParameters().isEmpty() &&
            ((TypeElement)method.getEnclosingElement()).getTypeParameters().isEmpty() &&
            types.isSameType(trees.getTypeMirror(path), method.getReturnType());
    }

    private static String sourceText(TreePath caller, ExpressionTree expression, SourcePositions positions, String source) {
        long start = positions.getStartPosition(caller.getCompilationUnit(), expression);
        long end = positions.getEndPosition(caller.getCompilationUnit(), expression);
        return start < 0 || end <= start || end > source.length() || end - start > 4096
            ? null : source.substring((int) start, (int) end);
    }
}
