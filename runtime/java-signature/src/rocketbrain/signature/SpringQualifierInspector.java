package rocketbrain.signature;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import javax.lang.model.element.Element;
import javax.lang.model.element.ElementKind;
import javax.lang.model.element.ExecutableElement;
import javax.lang.model.element.Modifier;
import javax.lang.model.element.TypeElement;
import javax.lang.model.element.VariableElement;
import javax.lang.model.type.DeclaredType;
import javax.lang.model.type.TypeMirror;
import javax.lang.model.util.Types;
import com.sun.source.tree.AnnotationTree;
import com.sun.source.tree.AssignmentTree;
import com.sun.source.tree.ClassTree;
import com.sun.source.tree.CompilationUnitTree;
import com.sun.source.tree.ExpressionTree;
import com.sun.source.tree.LiteralTree;
import com.sun.source.tree.MethodTree;
import com.sun.source.tree.ModifiersTree;
import com.sun.source.tree.Tree;
import com.sun.source.tree.VariableTree;
import com.sun.source.util.JavacTask;
import com.sun.source.util.SourcePositions;
import com.sun.source.util.TreePath;
import com.sun.source.util.TreePathScanner;
import com.sun.source.util.Trees;

import static rocketbrain.signature.SignatureInspector.object;

/** Read-only attribution of a Spring qualifier and compatible local source declarations. */
final class SpringQualifierInspector {
    private static final String QUALIFIER = "org.springframework.beans.factory.annotation.Qualifier";
    private static final String AUTOWIRED = "org.springframework.beans.factory.annotation.Autowired";
    private static final String INJECT = "jakarta.inject.Inject";
    private static final String BEAN = "org.springframework.context.annotation.Bean";
    private static final Set<String> COMPONENTS = Set.of(
        "org.springframework.stereotype.Component", "org.springframework.stereotype.Service",
        "org.springframework.stereotype.Repository", "org.springframework.stereotype.Controller",
        "org.springframework.web.bind.annotation.RestController", "org.springframework.context.annotation.Configuration",
        "org.springframework.boot.autoconfigure.SpringBootApplication", "jakarta.inject.Named"
    );

    private final Trees trees;
    private final Types types;
    private final SourcePositions positions;

    SpringQualifierInspector(JavacTask task) {
        trees = Trees.instance(task);
        types = task.getTypes();
        positions = trees.getSourcePositions();
    }

    private static boolean has(Element element, String annotation) {
        return element.getAnnotationMirrors().stream().anyMatch(item -> item.getAnnotationType().asElement()
            instanceof TypeElement type && type.getQualifiedName().contentEquals(annotation));
    }

    private static String plainType(TypeMirror mirror) {
        if (mirror instanceof DeclaredType type && type.getTypeArguments().isEmpty() &&
            type.asElement() instanceof TypeElement symbol && symbol.getTypeParameters().isEmpty()) {
            return symbol.getQualifiedName().toString();
        }
        return "";
    }

    private static TypeElement owner(Element element) {
        Element enclosing = element.getEnclosingElement();
        return enclosing instanceof TypeElement type ? type : (TypeElement) enclosing.getEnclosingElement();
    }

    private static String injectionKind(VariableElement variable) {
        Element enclosing = variable.getEnclosingElement();
        if (variable.getKind() == ElementKind.FIELD) {
            return !variable.getModifiers().contains(Modifier.STATIC) && !variable.getModifiers().contains(Modifier.FINAL) &&
                (has(variable, AUTOWIRED) || has(variable, INJECT)) ? "field" : "";
        }
        if (variable.getKind() != ElementKind.PARAMETER || !(enclosing instanceof ExecutableElement executable) ||
            executable.getModifiers().contains(Modifier.STATIC) && !has(executable, BEAN)) return "";
        if (executable.getKind() == ElementKind.CONSTRUCTOR) {
            long constructors = owner(executable).getEnclosedElements().stream()
                .filter(member -> member.getKind() == ElementKind.CONSTRUCTOR).count();
            return constructors == 1 || has(executable, AUTOWIRED) || has(executable, INJECT) ? "constructor" : "";
        }
        if (has(executable, BEAN)) return "factory-parameter";
        return has(executable, AUTOWIRED) || has(executable, INJECT) ? "method-parameter" : "";
    }

    Map<String,Object> inspect(List<CompilationUnitTree> units, CompilationUnitTree selected, int start, int end) {
        List<VariableElement> hits = new ArrayList<>();
        List<Long> annotationStarts = new ArrayList<>();
        new TreePathScanner<Void,Void>() {
            @Override public Void visitAnnotation(AnnotationTree node, Void unused) {
                TreePath current = getCurrentPath();
                var annotation = trees.getElement(new TreePath(current, node.getAnnotationType()));
                var parent = current.getParentPath();
                if (annotation instanceof TypeElement type && type.getQualifiedName().contentEquals(QUALIFIER) &&
                    parent.getLeaf() instanceof ModifiersTree && parent.getParentPath().getLeaf() instanceof VariableTree &&
                    trees.getElement(parent.getParentPath()) instanceof VariableElement variable &&
                    node.getArguments().size() == 1) {
                    ExpressionTree value = node.getArguments().getFirst();
                    if (value instanceof AssignmentTree assignment) value = assignment.getExpression();
                    if (value instanceof LiteralTree literal && literal.getValue() instanceof String &&
                        positions.getStartPosition(selected, value) == start && positions.getEndPosition(selected, value) == end) {
                        hits.add(variable);
                        annotationStarts.add(positions.getStartPosition(selected, node));
                    }
                }
                return super.visitAnnotation(node, unused);
            }
        }.scan(selected, null);
        if (hits.size() != 1) return object("site",null,"declarations",List.of());
        VariableElement injection = hits.getFirst();
        String requested = plainType(injection.asType()), origin = injectionKind(injection);
        if (requested.isEmpty() || origin.isEmpty()) return object("site",null,"declarations",List.of());
        var site = object("owner",owner(injection).getQualifiedName().toString(),"name",injection.getSimpleName().toString(),
            "type",requested,"origin",origin,"annotationStart",annotationStarts.getFirst());

        List<Map<String,Object>> declarations = new ArrayList<>();
        for (CompilationUnitTree unit : units) {
            new TreePathScanner<Void,Void>() {
                private void collect(Tree node, TypeMirror mirror, TypeElement owner, String kind) {
                    String type = plainType(mirror);
                    if (type.isEmpty() || !types.isAssignable(mirror, injection.asType())) return;
                    long from = positions.getStartPosition(unit,node), to = positions.getEndPosition(unit,node);
                    if (from < 0 || to <= from || declarations.size() > 500) return;
                    declarations.add(object("uri",unit.getSourceFile().toUri().toString(),"start",from,"end",to,
                        "owner",owner.getQualifiedName().toString(),"kind",kind,"type",type));
                }
                @Override public Void visitClass(ClassTree node, Void unused) {
                    if (trees.getElement(getCurrentPath()) instanceof TypeElement type &&
                        COMPONENTS.stream().anyMatch(annotation -> has(type,annotation))) {
                        collect(node,type.asType(),type,"component");
                    }
                    return super.visitClass(node,unused);
                }
                @Override public Void visitMethod(MethodTree node, Void unused) {
                    if (trees.getElement(getCurrentPath()) instanceof ExecutableElement method &&
                        method.getTypeParameters().isEmpty() && has(method,BEAN)) {
                        collect(node,method.getReturnType(),owner(method),"factory-method");
                    }
                    return null;
                }
            }.scan(unit,null);
        }
        return object("site",site,"declarations",declarations);
    }
}
