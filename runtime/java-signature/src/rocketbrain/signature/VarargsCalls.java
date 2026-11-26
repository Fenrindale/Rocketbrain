package rocketbrain.signature;

import com.sun.source.tree.ExpressionTree;
import com.sun.source.tree.LiteralTree;
import com.sun.source.tree.MethodTree;
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
import javax.lang.model.element.ElementKind;
import javax.lang.model.element.Modifier;
import javax.lang.model.element.TypeElement;
import javax.lang.model.type.ArrayType;
import javax.lang.model.type.TypeKind;
import javax.lang.model.util.Types;

import static rocketbrain.signature.SignatureInspector.object;

/** Compiler evidence for varargs parameter reordering and private array conversion. */
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

    static ArrayType conversionArray(ExecutableElement method) {
        if (method.getKind() != ElementKind.METHOD || !method.getModifiers().contains(Modifier.PRIVATE) ||
                !method.getAnnotationMirrors().isEmpty() || !method.getTypeParameters().isEmpty() || method.getParameters().isEmpty() ||
                !(method.getEnclosingElement() instanceof TypeElement owner) || owner.getKind() != ElementKind.CLASS ||
                !owner.getTypeParameters().isEmpty() || !(method.getParameters().getLast().asType() instanceof ArrayType array)) return null;
        var component = array.getComponentType();
        if (!component.getKind().isPrimitive() && !List.of("java.lang.String", "java.lang.Object").contains(component.toString())) return null;
        return array;
    }

    static Map<String,Object> declaration(TreePath path, MethodTree tree, ExecutableElement method, Trees trees, String text) {
        var array = conversionArray(method);
        if (array == null || !method.isVarArgs() || tree.getBody() == null) return Map.of();
        var positions = trees.getSourcePositions();
        var last = tree.getParameters().getLast();
        long start = positions.getStartPosition(path.getCompilationUnit(), last);
        long end = positions.getEndPosition(path.getCompilationUnit(), last);
        if (start < 0 || end <= start || end > text.length() || end - start > 512) return Map.of();
        String parameter = text.substring((int)start, (int)end);
        var name = java.util.regex.Pattern.quote(last.getName().toString());
        var match = java.util.regex.Pattern.compile(
            "^(?:final\\s+)?(?:[A-Za-z_$][\\w$]*\\.)*[A-Za-z_$][\\w$]*\\s*(\\.\\.\\.)\\s*" + name + "$").matcher(parameter);
        if (!match.matches()) return Map.of();
        return object("start",start + match.start(1),"end",start + match.end(1),"component",array.getComponentType().toString());
    }

    static Map<String,Object> conversion(TreePath path, ExecutableElement method, Trees trees, Types types, String text) {
        var array = conversionArray(method);
        if (array == null || !(path.getLeaf() instanceof MethodInvocationTree call)) return Map.of();
        var args = call.getArguments();
        int size = method.getParameters().size(), fixedCount = size - 1;
        if (args.size() < fixedCount || args.size() > 64 || size > 30) return Map.of();
        var positions = trees.getSourcePositions();
        String selector = sourceText(path,call.getMethodSelect(),positions,text);
        if (selector == null) return Map.of();
        var trailing = args.size() == size ? trees.getTypeMirror(new TreePath(path,args.getLast())) : null;
        boolean fixed = trailing != null && types.isAssignable(trailing,array);
        if (!method.isVarArgs() && !fixed) return Map.of();
        var arguments = new ArrayList<Map<String,Object>>();
        for (int index = 0; index < args.size(); index++) {
            var expression = args.get(index);
            var evidence = argument(path,expression,trees,text);
            if (evidence.isEmpty() || !fixed && index >= fixedCount && !standalone(path,expression,trees,types)) return Map.of();
            arguments.add(evidence);
        }
        var result = object("fixedCount",fixedCount,"mode",fixed ? "fixed-array" : "spread",
            "selector",selector,"arguments",arguments,"component",array.getComponentType().toString());
        if (fixed && args.getLast() instanceof NewArrayTree explicit && explicit.getInitializers() != null &&
                explicit.getInitializers().size() <= 64 && explicit.getDimensions().isEmpty() &&
                types.isSameType(trees.getTypeMirror(new TreePath(path,explicit)),array)) {
            var elements = new ArrayList<Map<String,Object>>();
            var arrayPath = new TreePath(path,explicit);
            for (var expression : explicit.getInitializers()) {
                var evidence = argument(arrayPath,expression,trees,text);
                if (evidence.isEmpty()) return Map.of();
                elements.add(evidence);
            }
            result.put("initializer",elements);
        }
        return result;
    }

    private static Map<String,Object> argument(TreePath parent, ExpressionTree expression, Trees trees, String source) {
        var positions = trees.getSourcePositions();
        String spelling = sourceText(parent,expression,positions,source);
        var actual = trees.getTypeMirror(new TreePath(parent,expression));
        if (spelling == null || actual == null || actual.getKind() == TypeKind.ERROR) return Map.of();
        return object("source",spelling,"type",actual.toString(),
            "start",positions.getStartPosition(parent.getCompilationUnit(),expression),
            "end",positions.getEndPosition(parent.getCompilationUnit(),expression));
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
