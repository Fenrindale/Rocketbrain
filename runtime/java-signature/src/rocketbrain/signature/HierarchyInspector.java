package rocketbrain.signature;

import com.sun.source.tree.*;
import com.sun.source.util.*;
import java.util.*;
import javax.lang.model.element.*;
import javax.lang.model.type.TypeKind;
import javax.lang.model.util.Elements;
import javax.lang.model.util.Types;

/** Source declarations and stable resolved references for reviewed hierarchy moves. */
final class HierarchyInspector {
    private final Trees trees;
    private final DocTrees docs;
    private final Types types;
    private final Elements elements;
    private final SourcePositions positions;

    HierarchyInspector(JavacTask task) {
        trees = Trees.instance(task);
        docs = DocTrees.instance(task);
        types = task.getTypes();
        elements = task.getElements();
        positions = trees.getSourcePositions();
    }

    private String slot(Element member) {
        if (member instanceof VariableElement && member.getKind().isField()) return "F:" + member.getSimpleName();
        if (member instanceof ExecutableElement method && member.getKind() == ElementKind.METHOD) {
            return "M:" + member.getSimpleName() + "(" + String.join(",",method.getParameters().stream()
                .map(parameter -> types.erasure(parameter.asType()).toString()).toList()) + ")";
        }
        return null;
    }

    private static String key(Element element) {
        if (element instanceof VariableElement field && element.getKind().isField() &&
                field.getEnclosingElement() instanceof TypeElement owner) {
            return "F:" + owner.getQualifiedName() + "#" + field.getSimpleName() + ":" + field.asType();
        }
        if (element instanceof ExecutableElement method && method.getEnclosingElement() instanceof TypeElement owner) {
            return owner.getQualifiedName().length() > 0 ? "M:" + SignatureInspector.key(method) :
                "local-method:" + method.getSimpleName() + ":" + method.asType();
        }
        if (element instanceof TypeElement type) return "T:" + type.getQualifiedName();
        if (element instanceof PackageElement pkg) return "P:" + pkg.getQualifiedName();
        return element == null ? "" : element.getKind() + ":" + element.getSimpleName() + ":" + element.asType();
    }

    private List<TypeElement> ancestors(TypeElement start) {
        var seen = new LinkedHashMap<String,TypeElement>();
        var pending = new ArrayDeque<TypeElement>();
        pending.add(start);
        while (!pending.isEmpty()) {
            var current = pending.removeFirst();
            for (var parent : types.directSupertypes(current.asType())) {
                if (types.asElement(parent) instanceof TypeElement declaration &&
                        seen.putIfAbsent(declaration.getQualifiedName().toString(),declaration) == null) {
                    pending.addLast(declaration);
                }
            }
        }
        return new ArrayList<>(seen.values());
    }

    private boolean executable(ExecutableElement method, MethodTree declaration) {
        if (declaration.getBody() == null || method.isVarArgs() || !method.getTypeParameters().isEmpty() ||
                !method.getAnnotationMirrors().isEmpty() || !method.getReturnType().getAnnotationMirrors().isEmpty() ||
                method.getParameters().stream().anyMatch(parameter ->
                    !parameter.getAnnotationMirrors().isEmpty() || !parameter.asType().getAnnotationMirrors().isEmpty())) return false;
        return method.getModifiers().stream().allMatch(modifier ->
            EnumSet.of(Modifier.PUBLIC,Modifier.PROTECTED,Modifier.FINAL).contains(modifier));
    }

    private int commentStart(TreePath declaration, int start, String original) {
        if (docs.getDocCommentTree(declaration) == null) return start;
        int before = original.lastIndexOf("/**",start);
        if (before >= 0) {
            int close = original.indexOf("*/",before);
            if (close >= before && close + 2 <= start && original.substring(close + 2,start).isBlank()) return before;
        }
        return start;
    }

    private Map<String,Object> member(CompilationUnitTree unit, Element element, String source, String uri) {
        final String slot = slot(element);
        var path = trees.getPath(element);
        if (path == null || slot == null) return null;
        var declaration = path.getLeaf();
        long start = positions.getStartPosition(unit,declaration), end = positions.getEndPosition(unit,declaration);
        if (start < 0 || end <= start || end > source.length()) return null;
        boolean movable = false;
        String constant = null;
        if (element instanceof ExecutableElement method && declaration instanceof MethodTree tree) {
            movable = executable(method,tree);
        } else if (element instanceof VariableElement field && declaration instanceof VariableTree tree) {
            Object value = field.getConstantValue();
            movable = value != null && field.getModifiers().containsAll(Set.of(Modifier.STATIC,Modifier.FINAL)) &&
                !field.getModifiers().contains(Modifier.PRIVATE) && field.getAnnotationMirrors().isEmpty() &&
                field.asType().getAnnotationMirrors().isEmpty() && tree.getInitializer() != null;
            if (value != null) constant = value.getClass().getName() + ":" + value.toString();
        }
        return SignatureInspector.object("key",key(element),"slot",slot,"name",element.getSimpleName().toString(),
            "uri",uri,"start",start,"end",end,"commentStart",commentStart(path,(int)start,source),"movable",movable,
            "type",element.asType().toString(),"modifiers",SignatureInspector.modifiers(element),"constant",constant);
    }

    private Map<String,Object> type(CompilationUnitTree unit, TypeElement element, ClassTree node, String uri, String text) {
        long start = positions.getStartPosition(unit,node),end = positions.getEndPosition(unit,node);
        if (start < 0 || end <= start || end > text.length()) return null;
        var ancestorTypes = ancestors(element);
        var slots = new TreeSet<String>();
        for (var parent : ancestorTypes) {
            for (var inherited : parent.getEnclosedElements()) {
                String inheritedSlot = slot(inherited);
                if (inheritedSlot != null) slots.add(inheritedSlot);
            }
        }
        String superclass = element.getSuperclass().getKind() == TypeKind.DECLARED &&
                types.asElement(element.getSuperclass()) instanceof TypeElement parent ? parent.getQualifiedName().toString() : "";
        boolean plain = element.getKind() == ElementKind.CLASS && element.getNestingKind() == NestingKind.TOP_LEVEL &&
            element.getTypeParameters().isEmpty() && element.getAnnotationMirrors().isEmpty() && element.getInterfaces().isEmpty() &&
            !element.getModifiers().contains(Modifier.SEALED) && !element.getModifiers().contains(Modifier.NON_SEALED) &&
            (superclass.isEmpty() || superclass.equals(element.getSuperclass().toString()));
        var members = new ArrayList<Map<String,Object>>();
        for (var declaration : element.getEnclosedElements()) {
            var item = member(unit,declaration,text,uri);
            if (item != null) members.add(item);
        }
        return SignatureInspector.object("id",element.getQualifiedName().toString(),"name",element.getSimpleName().toString(),
            "uri",uri,"start",start,"end",end,"package",elements.getPackageOf(element).getQualifiedName().toString(),
            "superclass",superclass,"ancestors",ancestorTypes.stream().map(item -> item.getQualifiedName().toString()).toList(),
            "inheritedSlots",slots,"members",members,"plain",plain);
    }

    Map<String,Object> inspect(List<CompilationUnitTree> units, Map<String,SignatureInspector.Source> sources) {
        var declarations = new ArrayList<Map<String,Object>>();
        var files = new ArrayList<Map<String,Object>>();
        int totalEvents = 0;
        for (var unit : units) {
            String uri = unit.getSourceFile().toUri().toString(), text = sources.get(uri).text;
            var events = new ArrayList<Map<String,Object>>();
            new TreePathScanner<Void,Void>() {
                @Override public Void visitClass(ClassTree node, Void unused) {
                    if (trees.getElement(getCurrentPath()) instanceof TypeElement element && !element.getQualifiedName().isEmpty()) {
                        var item = type(unit,element,node,uri,text);
                        if (item != null) declarations.add(item);
                    }
                    return super.visitClass(node,unused);
                }
                void event(Tree node) {
                    long start = positions.getStartPosition(unit,node),end = positions.getEndPosition(unit,node);
                    if (start < 0 || end <= start || end > text.length()) return;
                    var path = getCurrentPath();
                    var mirror = trees.getTypeMirror(path);
                    var element = trees.getElement(path);
                    String receiver = node instanceof IdentifierTree identifier &&
                        (identifier.getName().contentEquals("this") || identifier.getName().contentEquals("super")) ?
                        identifier.getName().toString() : node instanceof MemberSelectTree select &&
                          (select.getIdentifier().contentEquals("this") || select.getIdentifier().contentEquals("super")) ?
                          select.getIdentifier().toString() : "";
                    events.add(SignatureInspector.object("start",start,"end",end,"kind",node.getKind().name(),
                        "key",key(element),"type",mirror == null ? "" : mirror.toString(),"receiver",receiver));
                }
                @Override public Void visitIdentifier(IdentifierTree tree, Void unused) { event(tree); return super.visitIdentifier(tree,unused); }
                @Override public Void visitMemberSelect(MemberSelectTree tree, Void unused) { event(tree); return super.visitMemberSelect(tree,unused); }
                @Override public Void visitMethodInvocation(MethodInvocationTree tree, Void unused) { event(tree); return super.visitMethodInvocation(tree,unused); }
                @Override public Void visitNewClass(NewClassTree tree, Void unused) { event(tree); return super.visitNewClass(tree,unused); }
                @Override public Void visitMemberReference(MemberReferenceTree tree, Void unused) { event(tree); return super.visitMemberReference(tree,unused); }
            }.scan(unit,null);
            if ((totalEvents += events.size()) > 24000 || declarations.size() > 350) {
                throw new IllegalArgumentException("The Java hierarchy proof exceeds its declaration or reference limit.");
            }
            files.add(SignatureInspector.object("uri",uri,"events",events));
        }
        return SignatureInspector.object("classes",declarations,"files",files);
    }
}
