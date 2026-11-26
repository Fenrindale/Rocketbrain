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

/** Describes references that can become lambdas without changing argument conversions. */
final class SignatureReferences {
    private SignatureReferences() {}

    private static boolean isDirectTarget(MemberReferenceTree reference, Tree parent) {
        return parent instanceof ReturnTree returned && returned.getExpression() == reference ||
            parent instanceof VariableTree variable && variable.getInitializer() == reference ||
            parent instanceof TypeCastTree cast && cast.getExpression() == reference;
    }

    static Map<String,Object> adapter(MemberReferenceTree reference, ExecutableElement method,
            TreePath member, Trees trees, Types types, Elements elements, String text) {
        if (method.isVarArgs() || !method.getTypeParameters().isEmpty() || trees.getPath(method) == null ||
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
        if (parameters.size() != method.getParameters().size() + receiver) return null;
        for (int index = 0; index < method.getParameters().size(); index++) {
            if (!types.isSameType(parameters.get(index + receiver), method.getParameters().get(index).asType())) return null;
        }
        String name = kind.equals("constructor") ? "new" : reference.getName().toString();
        return object("kind",kind,"receiver",receiver,"qualifier",spelling,"name",name,
            "qualifierEnd",to,"arity",parameters.size(),"targetType",target.toString());
    }
}
