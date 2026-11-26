package rocketbrain.signature;

import com.sun.source.tree.MemberReferenceTree;
import com.sun.source.tree.ReturnTree;
import com.sun.source.tree.Tree;
import com.sun.source.tree.TypeCastTree;
import com.sun.source.tree.VariableTree;
import com.sun.source.util.TreePath;
import com.sun.source.util.Trees;
import java.util.List;
import java.util.Map;
import javax.lang.model.element.ElementKind;
import javax.lang.model.element.ExecutableElement;
import javax.lang.model.element.Modifier;
import javax.lang.model.element.NestingKind;
import javax.lang.model.element.TypeElement;
import javax.lang.model.type.DeclaredType;
import javax.lang.model.type.ExecutableType;
import javax.lang.model.type.TypeMirror;
import javax.lang.model.util.Elements;
import javax.lang.model.util.Types;

import static rocketbrain.signature.SignatureInspector.object;

/** Reports attributed references that can be kept or adapted during signature changes. */
final class SignatureReferences {
    private SignatureReferences() {}

    private static boolean isDirectTarget(MemberReferenceTree reference, Tree parent) {
        return parent instanceof ReturnTree returned && returned.getExpression() == reference ||
            parent instanceof VariableTree variable && variable.getInitializer() == reference ||
            parent instanceof TypeCastTree cast && cast.getExpression() == reference;
    }

    static Map<String,Object> inspect(MemberReferenceTree reference, ExecutableElement method,
            TreePath member, Trees trees, Types types, Elements elements, String text, boolean arrayConversion) {
        var array = arrayConversion ? VarargsCalls.conversionArray(method) : null;
        if ((arrayConversion ? array == null || method.getParameters().size() > 30 : method.isVarArgs()) ||
            !method.getTypeParameters().isEmpty() || trees.getPath(method) == null ||
            reference.getTypeArguments() != null && !reference.getTypeArguments().isEmpty() ||
            !isDirectTarget(reference, member.getParentPath().getLeaf()) ||
            !(method.getEnclosingElement() instanceof TypeElement owner) || !owner.getTypeParameters().isEmpty()) return null;

        TypeMirror target = trees.getTypeMirror(member);
        if (!(target instanceof DeclaredType functional) || !(functional.asElement() instanceof TypeElement iface) ||
            iface.getKind() != ElementKind.INTERFACE ||
            types.isAssignable(target, elements.getTypeElement("java.io.Serializable").asType())) return null;
        List<ExecutableElement> abstractMethods = elements.getAllMembers(iface).stream()
            .filter(element -> element instanceof ExecutableElement && element.getModifiers().contains(Modifier.ABSTRACT))
            .map(ExecutableElement.class::cast).toList();
        if (abstractMethods.size() != 1 || !abstractMethods.getFirst().getTypeParameters().isEmpty()) return null;
        var descriptor = (ExecutableType) types.asMemberOf(functional, abstractMethods.getFirst());
        var parameters = descriptor.getParameterTypes();
        var qualifier = reference.getQualifierExpression();
        var qualifierPath = new TreePath(member, qualifier);
        var qualifiedType = trees.getElement(qualifierPath) instanceof TypeElement;
        var positions = trees.getSourcePositions();
        var unit = member.getCompilationUnit();
        long from = positions.getStartPosition(unit, qualifier), to = positions.getEndPosition(unit, qualifier);
        if (from < 0 || to <= from || to > text.length()) return null;
        String spelling = text.substring((int) from, (int) to);
        if (!spelling.matches("[A-Za-z_$][A-Za-z0-9_$]*(\\.[A-Za-z_$][A-Za-z0-9_$]*)*")) return null;
        String kind;
        if (method.getKind() == ElementKind.CONSTRUCTOR) {
            if (!qualifiedType || owner.getNestingKind() != NestingKind.TOP_LEVEL &&
                    !owner.getModifiers().contains(Modifier.STATIC)) return null;
            kind = "constructor";
        } else if (method.getModifiers().contains(Modifier.STATIC)) {
            if (!qualifiedType) return null;
            kind = "static";
        } else if (qualifiedType) {
            if (parameters.isEmpty() || !types.isSameType(parameters.getFirst(), trees.getTypeMirror(qualifierPath))) return null;
            kind = "unbound";
        } else {
            if (!spelling.equals("this")) return null;
            kind = "this";
        }
        int receiver = kind.equals("unbound") ? 1 : 0;
        int fixedCount = method.getParameters().size() - (arrayConversion ? 1 : 0);
        if (arrayConversion && parameters.size() > 64 || parameters.size() < fixedCount + receiver ||
                !arrayConversion && parameters.size() != fixedCount + receiver) return null;
        for (int index = 0; index < fixedCount; index++) {
            if (!types.isSameType(parameters.get(index + receiver), method.getParameters().get(index).asType())) return null;
        }
        String name = kind.equals("constructor") ? "new" : reference.getName().toString();
        var result = object("kind",kind,"receiver",receiver,"qualifier",spelling,"name",name,
            "qualifierEnd",to,"arity",parameters.size(),"targetType",target.toString());
        if (!arrayConversion) return result;

        boolean fixed = parameters.size() == fixedCount + receiver + 1 && types.isAssignable(parameters.getLast(),array);
        var component = array.getComponentType();
        if (!fixed) {
            // An unbound receiver can be null. A generated array would move allocation
            // across the reference invocation's receiver check.
            if (!method.isVarArgs() || receiver != 0 || !types.isSameType(descriptor.getReturnType(),method.getReturnType())) return null;
            for (int index = fixedCount; index < parameters.size(); index++) {
                if (!types.isSameType(parameters.get(index),component)) return null;
            }
        }
        long start = positions.getStartPosition(unit, reference), end = positions.getEndPosition(unit, reference);
        if (start < 0 || end <= start || end > text.length() || end - start > 512) return null;
        result.put("mode",fixed ? "fixed-array" : "spread");
        result.put("component",component.toString());
        result.put("fixedCount",fixedCount);
        result.put("parameterTypes",parameters.stream().map(TypeMirror::toString).toList());
        result.put("returnType",descriptor.getReturnType().toString());
        result.put("source",text.substring((int)start,(int)end));
        return result;
    }
}
